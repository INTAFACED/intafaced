import { randomUUID } from 'node:crypto';
import { keccak256, toHex, type TypedDataDefinition } from 'viem';
import { privateKeyToAccount, type PrivateKeyAccount } from 'viem/accounts';
import { add, compare, div, formatAmount, mul, parseAmount, sub, ZERO, type Amount } from '@intafaced/ledger-client/money';
import { AuthError, type Principal } from '@intafaced/auth';
import { JurisdictionError } from '@intafaced/contracts';
import {
  VenueRefusalError,
  type PlaceUserOrderIntent,
  type UserVenueAccount,
  type UserVenueMarket,
  type UserVenueOrder,
  type VenueSubmitOutcome,
} from '@intafaced/venue-contracts';
import type { AccountFreezeRead } from '../quant/live-run/ports.js';
import { assertPlaceEligible } from '../spot/place-eligibility.js';
import { engineActor } from './protections.js';
import type { SpotConditional, SpotConditionalKind, SpotConditionalStatus, SpotConditionalStore } from './spot-conditional-store.js';
import {
  assertTradingLevel,
  UserVenueDoorError,
  type PreparedAnswer,
  type UserVenueDoor,
  type VenueOrderByKey,
} from './user-venue-door.js';

/**
 * CONDITIONAL SPOT ORDERS ON THE PERSON'S OWN VENUE ACCOUNT (J-cex-spot-08; SP-conditional-algo-01, -02).
 *
 * Money (J-cex-spot-08 "Money"): no value moves through INTAFACED and the ledger posts nothing. Whether the venue holds a
 * stop on a spot market is the market's own declaration (`triggerSources`, the adapter's reading of the venue's
 * documentation): a stop it holds rests there as its trigger order, signed by the person's own wallet, and the venue
 * locks the funds at placement. A kind it lacks is held by our engine, locks nothing at the venue until it fires, and
 * is then sent once, signed by an agent key INTAFACED derives for the person's spot orders and the person's wallet
 * approves on the venue (the agent permission). An OCO's take profit rests on the venue as an ordinary limit order, the
 * one venue lock both legs share; its stop loss is held by our engine, which cancels the take profit (releasing its
 * lock) before it sends the stop. A take-profit fill on the venue ends the stop loss once; a partial fill leaves the
 * stop loss on what is still resting. A bracket's entry is the person's own signed order; once it is final, the coins it
 * received are put behind one OCO exit pair; an entry that filled nothing places no exit. A linked close
 * (one-triggers-other) is placed on the venue when its entry fills, and is cancelled with the entry before that.
 *
 * Crash points (whose funds are stranded?): none. Every venue order here is stored under a business key before it is
 * sent (`spot-cond:<owner>:<client>:tp|close|entry`, `spot-cond:fire:<owner>:<client>`), the venue's client order id
 * derives from that key, and a worker that crashes after a claim sends the same order again on its next pass, which the
 * venue takes once. The funds only ever sit on the person's own venue account.
 */

export type SpotConditionalErrorCode =
  | 'trade.spot_conditional_invalid'
  | 'trade.spot_conditional_trigger_missing'
  | 'trade.spot_conditional_field_unsupported'
  | 'trade.spot_conditional_wrong_side'
  | 'trade.spot_conditional_no_reference'
  | 'trade.spot_conditional_insufficient'
  | 'trade.spot_conditional_key_reused'
  | 'trade.oco_stop_limit_missing'
  | 'trade.oco_legs_out_of_order'
  | 'trade.spot_agent_unapproved'
  | 'trade.spot_agent_key_unset'
  | 'trade.spot_conditional_unknown'
  | 'trade.spot_conditional_final';

export class SpotConditionalError extends Error {
  constructor(
    readonly code: SpotConditionalErrorCode,
    message: string,
    readonly status: number,
  ) {
    super(message);
    this.name = 'SpotConditionalError';
  }
}

/** The label every order our engine holds carries, wherever it is shown. */
export const SPOT_ENGINE_LABEL = 'Run by INTAFACED on our engine under your agent permission';
export const SPOT_VENUE_LABEL = 'Rests on the venue as its trigger order';
/** The agent name the person's wallet sees when it approves the spot-order key on the venue. */
export const SPOT_AGENT_NAME = 'spot-orders';

const KINDS: readonly SpotConditionalKind[] = ['stop_limit', 'stop_market', 'oco', 'bracket', 'oto'];
type Field = 'triggerPrice' | 'limitPrice' | 'takeProfitPrice' | 'entryPrice' | 'closePrice';
const FIELDS: readonly Field[] = ['triggerPrice', 'limitPrice', 'takeProfitPrice', 'entryPrice', 'closePrice'];
/** The price fields each kind takes, and which of them it needs (`limitPrice` on an OCO or bracket is judged by side). */
const TAKES: Readonly<Record<SpotConditionalKind, { readonly needs: readonly Field[]; readonly may: readonly Field[] }>> = {
  stop_limit: { needs: ['triggerPrice', 'limitPrice'], may: [] },
  stop_market: { needs: ['triggerPrice'], may: [] },
  oco: { needs: ['takeProfitPrice', 'triggerPrice'], may: ['limitPrice'] },
  bracket: { needs: ['entryPrice', 'takeProfitPrice', 'triggerPrice'], may: ['limitPrice'] },
  oto: { needs: ['entryPrice', 'closePrice'], may: [] },
};
const FIELD_WORDS: Readonly<Record<Field, string>> = {
  triggerPrice: 'a trigger price',
  limitPrice: 'a limit price',
  takeProfitPrice: 'a take-profit price',
  entryPrice: 'an entry price',
  closePrice: 'a close price',
};
const KIND_WORDS: Readonly<Record<SpotConditionalKind, string>> = {
  stop_limit: 'stop-limit',
  stop_market: 'stop-market',
  oco: 'OCO',
  bracket: 'bracket',
  oto: 'linked close',
};

export interface SpotConditionalRequest {
  readonly owner?: unknown;
  readonly symbol?: unknown;
  readonly kind?: unknown;
  readonly side?: unknown;
  readonly quantity?: unknown;
  readonly triggerPrice?: unknown;
  readonly limitPrice?: unknown;
  readonly takeProfitPrice?: unknown;
  readonly entryPrice?: unknown;
  readonly entryTif?: unknown;
  readonly closePrice?: unknown;
  readonly clientOrderId?: unknown;
}

export type SpotLegRole = 'stop' | 'take_profit' | 'stop_loss' | 'entry' | 'close';
export type SpotLegStatus = 'waiting' | 'armed' | 'triggered' | 'open' | 'partially_filled' | 'filled' | 'cancelled' | 'failed';

export interface SpotLegView {
  readonly role: SpotLegRole;
  readonly side: 'buy' | 'sell';
  readonly type: 'limit' | 'market';
  readonly price: string | null;
  readonly triggerPrice: string | null;
  readonly quantity: string;
  readonly restsOn: 'venue' | 'engine';
  /** Who signs it: the person's own wallet, or the agent key under their permission. */
  readonly signedBy: 'wallet' | 'agent';
  readonly status: SpotLegStatus;
  readonly orderKey: string | null;
  readonly venueClientOrderId: string | null;
  readonly filled: string | null;
  readonly locked: string | null;
  readonly lockedAsset: string | null;
  /** The leg it waits on or is cancelled with. */
  readonly linkedTo: SpotLegRole | null;
}

export interface SpotConditionalView {
  readonly id: string;
  readonly clientOrderId: string;
  readonly kind: SpotConditionalKind;
  readonly symbol: string;
  readonly side: 'buy' | 'sell';
  readonly quantity: string;
  readonly status: SpotConditionalStatus;
  readonly restsOn: 'engine';
  readonly label: string;
  readonly agentPermission: { readonly agentAddress: string };
  readonly triggerSource: 'last';
  readonly triggerPrice: string | null;
  readonly limitPrice: string | null;
  readonly takeProfitPrice: string | null;
  readonly entryPrice: string | null;
  readonly entryTif: 'GTC' | 'IOC' | null;
  readonly closePrice: string | null;
  readonly exitQuantity: string | null;
  /** The venue's last traded price now, the price a stop here is judged on; null where it has none. */
  readonly referencePrice: string | null;
  readonly failure: string | null;
  readonly cancelReason: string | null;
  readonly createdAt: string;
  readonly legs: readonly SpotLegView[];
}

export type SpotConditionalCreated =
  | { readonly restsOn: 'venue'; readonly actionKey: string; readonly prepared: PreparedAnswer['prepared']; readonly reused: boolean }
  | {
      readonly restsOn: 'engine';
      readonly conditional: SpotConditionalView;
      readonly reused: boolean;
      /** A bracket's or linked close's entry, unsigned, for the person's own wallet. */
      readonly entry: PreparedAnswer | null;
    };

export interface SpotFeeLeg {
  readonly role: SpotLegRole;
  readonly side: 'buy' | 'sell';
  readonly liquidity: 'maker' | 'taker';
  readonly price: string;
  readonly quantity: string;
  readonly venueFeeBps: string | null;
  readonly builderFeeBps: string | null;
  readonly feeAsset: string;
  /** The venue's fee plus our builder fee at that price and size; null where the venue publishes no rate. */
  readonly estimatedFee: string | null;
}

export interface SpotConditionalsDeps {
  readonly door: UserVenueDoor;
  readonly store: SpotConditionalStore;
  /** `TRADE_AGENT_KEY_SEED`: the owner's secret the spot-order key derives from. Blank refuses every engine order. */
  readonly keySeed: string;
  /** The person's level from identity before each order our engine sends; null, or a read that fails, sends nothing. */
  readonly liveTier: ((userId: string) => Promise<Principal['tier']>) | null;
  /** The person's own account freeze before each order our engine sends; null, or a read that fails, sends nothing. */
  readonly freeze: AccountFreezeRead | null;
  readonly now: () => Date;
}

const DECIMAL_RE = /^\d+(\.\d+)?$/;
const CLIENT_ID_RE = /^[A-Za-z0-9_-]{1,64}$/;
const FINAL: ReadonlySet<string> = new Set(['filled', 'canceled', 'rejected', 'expired']);
const TEN_THOUSAND = parseAmount('10000');

function bad(message: string, code: SpotConditionalErrorCode = 'trade.spot_conditional_invalid'): never {
  throw new SpotConditionalError(code, message, 400);
}

const given = (v: unknown) => v !== undefined && v !== null && v !== '';

function positive(v: unknown, field: string): Amount {
  if (typeof v !== 'string' || !DECIMAL_RE.test(v.trim())) bad(`${field} must be a decimal string`);
  const amount = parseAmount(v.trim());
  if (compare(amount, ZERO) <= 0) bad(`${field} must be above zero`);
  return amount;
}

const other = (side: 'buy' | 'sell'): 'buy' | 'sell' => (side === 'buy' ? 'sell' : 'buy');
const fmt = (v: Amount | null) => (v === null ? null : formatAmount(v));
const floorTo = (v: Amount, step: Amount) => (step === ZERO ? v : v - (v % step));

/** Whether the venue holds a stop on this spot market itself: its own declaration, never our guess. */
export function spotStopRestsOn(market: Pick<UserVenueMarket, 'kind' | 'triggerSources'>): 'venue' | 'engine' {
  return market.kind === 'spot' && (market.triggerSources ?? []).includes('last') ? 'venue' : 'engine';
}

/** The business keys of a conditional's venue orders. */
export const spotKeys = {
  leg: (row: Pick<SpotConditional, 'owner' | 'clientKey'>, leg: 'tp' | 'close' | 'entry') =>
    `spot-cond:${row.owner}:${row.clientKey}:${leg}`,
  fire: (row: Pick<SpotConditional, 'owner' | 'clientKey'>) => `spot-cond:fire:${row.owner}:${row.clientKey}`,
};

interface Parsed {
  readonly kind: SpotConditionalKind;
  readonly side: 'buy' | 'sell';
  readonly symbol: string;
  readonly clientOrderId: string;
  readonly quantity: Amount;
  readonly prices: Readonly<Record<Field, Amount | null>>;
  readonly entryTif: 'GTC' | 'IOC' | null;
}

/** The request on its face: every refusal here is before anything is read, stored or signed. */
function parse(req: SpotConditionalRequest): Parsed {
  if (typeof req.kind !== 'string' || !KINDS.includes(req.kind as SpotConditionalKind))
    bad('kind must be stop_limit, stop_market, oco, bracket or oto');
  const kind = req.kind as SpotConditionalKind;
  if (req.side !== 'buy' && req.side !== 'sell') bad('side must be buy or sell');
  const side = req.side;
  if (typeof req.symbol !== 'string' || req.symbol.trim() === '') bad('symbol is required');
  if (typeof req.clientOrderId !== 'string' || !CLIENT_ID_RE.test(req.clientOrderId))
    bad('clientOrderId must be 1 to 64 letters, digits, - or _');
  const takes = TAKES[kind];
  for (const field of FIELDS) {
    const has = given(req[field]);
    if (has && !takes.needs.includes(field) && !takes.may.includes(field)) {
      throw new SpotConditionalError(
        'trade.spot_conditional_field_unsupported',
        `a ${KIND_WORDS[kind]} does not take ${FIELD_WORDS[field]}`,
        400,
      );
    }
    if (!has && takes.needs.includes(field)) {
      if (field === 'triggerPrice') {
        throw new SpotConditionalError(
          'trade.spot_conditional_trigger_missing',
          `A ${KIND_WORDS[kind]} needs a trigger price: it is the price that sets it off. Nothing was placed and nothing is held.`,
          400,
        );
      }
      bad(`a ${KIND_WORDS[kind]} needs ${FIELD_WORDS[field]}`);
    }
  }
  // The stop loss's limit, by the side the stop loss goes: a buy stop loss needs one, so it never buys at any price.
  const exitSide = kind === 'bracket' ? other(side) : side;
  if ((kind === 'oco' || kind === 'bracket') && exitSide === 'buy' && !given(req.limitPrice)) {
    throw new SpotConditionalError(
      'trade.oco_stop_limit_missing',
      'A buy stop loss needs a stop-loss limit: the most you will pay when it fires. Nothing was placed.',
      400,
    );
  }
  const prices = Object.fromEntries(
    FIELDS.map((f) => [f, given(req[f]) ? positive(req[f], FIELD_WORDS[f].replace(/^an? /, '')) : null]),
  ) as Record<Field, Amount | null>;
  let entryTif: 'GTC' | 'IOC' | null = null;
  if (kind === 'bracket' || kind === 'oto') {
    const tif = req.entryTif ?? 'GTC';
    if (tif !== 'GTC' && tif !== 'IOC') bad('entryTif must be GTC or IOC');
    entryTif = tif;
  } else if (given(req.entryTif)) {
    throw new SpotConditionalError('trade.spot_conditional_field_unsupported', `a ${KIND_WORDS[kind]} does not take an entry`, 400);
  }
  return {
    kind,
    side,
    symbol: req.symbol.trim(),
    clientOrderId: req.clientOrderId,
    quantity: positive(req.quantity, 'quantity'),
    prices,
    entryTif,
  };
}

/** The legs' prices in order: refused in words when a leg sits on the wrong side of the other or of the last price. */
function assertOrder(p: Parsed, last: Amount | null): void {
  const { kind, side } = p;
  const tp = p.prices.takeProfitPrice;
  const trigger = p.prices.triggerPrice;
  const limit = p.prices.limitPrice;
  const entry = p.prices.entryPrice;
  const out = (message: string): never => {
    throw new SpotConditionalError('trade.oco_legs_out_of_order', `${message} Nothing was placed.`, 400);
  };
  if (kind === 'oco' || kind === 'bracket') {
    const exit = kind === 'bracket' ? other(side) : side;
    // A sell exit takes profit above and stops out below; a buy exit the other way round.
    if (exit === 'sell' && compare(tp!, trigger!) <= 0)
      out(`The take-profit price must be above the stop-loss trigger: ${formatAmount(tp!)} is not above ${formatAmount(trigger!)}.`);
    if (exit === 'buy' && compare(tp!, trigger!) >= 0)
      out(`The take-profit price must be below the stop-loss trigger: ${formatAmount(tp!)} is not below ${formatAmount(trigger!)}.`);
    if (limit !== null && (exit === 'sell' ? compare(limit, trigger!) > 0 : compare(limit, trigger!) < 0))
      out(`The stop-loss limit must be ${exit === 'sell' ? 'at or below' : 'at or above'} its trigger (${formatAmount(trigger!)}).`);
    const around = kind === 'bracket' ? entry! : last;
    if (around !== null) {
      const where = kind === 'bracket' ? `the entry price (${formatAmount(entry!)})` : `the last trade (${formatAmount(around)})`;
      if (exit === 'sell' && !(compare(tp!, around) > 0 && compare(trigger!, around) < 0))
        out(`The take profit must be above ${where} and the stop loss below it.`);
      if (exit === 'buy' && !(compare(tp!, around) < 0 && compare(trigger!, around) > 0))
        out(`The take profit must be below ${where} and the stop loss above it.`);
    }
  }
  if (kind === 'oto') {
    const close = p.prices.closePrice!;
    if (side === 'buy' && compare(close, entry!) <= 0)
      out(`The close of a buy entry sells above it: ${formatAmount(close)} is not above ${formatAmount(entry!)}.`);
    if (side === 'sell' && compare(close, entry!) >= 0)
      out(`The close of a sell entry buys below it: ${formatAmount(close)} is not below ${formatAmount(entry!)}.`);
  }
  if (kind === 'stop_limit' || kind === 'stop_market') {
    if (last === null) return;
    // A stop that is already crossed would fire at once: a sell stop sits below the last trade, a buy stop above it.
    if (side === 'sell' ? compare(trigger!, last) >= 0 : compare(trigger!, last) <= 0) {
      throw new SpotConditionalError(
        'trade.spot_conditional_wrong_side',
        `A ${side} stop's trigger must be ${side === 'sell' ? 'below' : 'above'} the last trade (now ${formatAmount(last)}). Nothing was placed.`,
        400,
      );
    }
    if (kind === 'stop_limit' && (side === 'sell' ? compare(limit!, trigger!) > 0 : compare(limit!, trigger!) < 0)) {
      throw new SpotConditionalError(
        'trade.oco_legs_out_of_order',
        `A ${side} stop-limit's limit must be ${side === 'sell' ? 'at or below' : 'at or above'} its trigger (${formatAmount(trigger!)}). Nothing was placed.`,
        400,
      );
    }
  }
}

const sameTerms = (row: SpotConditional, p: Parsed, symbol: string) =>
  row.kind === p.kind &&
  row.side === p.side &&
  row.symbol === symbol &&
  row.quantity === p.quantity &&
  row.takeProfitPrice === p.prices.takeProfitPrice &&
  row.entryPrice === p.prices.entryPrice &&
  row.closePrice === p.prices.closePrice &&
  row.entryTif === p.entryTif;

export class VenueSpotConditionals {
  constructor(private readonly deps: SpotConditionalsDeps) {}

  /** The venue agent key INTAFACED holds for one person's spot orders on one venue account. Derived, never stored. */
  spotKey(userId: string, owner: string): PrivateKeyAccount {
    if (this.deps.keySeed.trim() === '') {
      throw new SpotConditionalError(
        'trade.spot_agent_key_unset',
        'no key seed is set for spot-order agent keys (owner value blank), so no order runs on our engine',
        503,
      );
    }
    return privateKeyToAccount(
      keccak256(toHex(`intafaced spot order key\u0000${this.deps.keySeed}\u0000${userId}\u0000${owner.toLowerCase()}`)),
    );
  }

  /** Whether the person's venue account has approved the spot-order key, as the venue lists its agents now. */
  async agent(principal: Principal, owner: string) {
    const account = await this.deps.door.account(owner);
    const address = this.spotKey(principal.userId, account.owner).address.toLowerCase();
    const venue = await this.deps.door.venue();
    const listed = (await venue.agents(account)).value.find((a) => a.address.toLowerCase() === address) ?? null;
    const live = listed !== null && (listed.validUntil === null || listed.validUntil.getTime() > this.deps.now().getTime());
    return { agentAddress: address, agentName: SPOT_AGENT_NAME, approved: live, validUntil: listed?.validUntil ?? null };
  }

  /** The person's wallet approves the spot-order key on their venue account: the agent permission our engine needs. */
  async prepareAgent(principal: Principal, owner: string): Promise<PreparedAnswer> {
    const account = await this.deps.door.account(owner);
    const address = this.spotKey(principal.userId, account.owner).address.toLowerCase();
    return this.deps.door.prepare(principal, {
      owner: account.owner,
      signer: { role: 'owner', address: account.owner },
      intent: { kind: 'approve_agent', agentAddress: address, agentName: SPOT_AGENT_NAME, validUntil: null },
      actionKey: `spot-agent:${account.owner}:${address}`,
    });
  }

  private async spotMarket(owner: string, symbol: string) {
    const account = await this.deps.door.account(owner);
    const venue = await this.deps.door.venue();
    const market = (await venue.markets(account)).value.find((m) => m.symbol === symbol);
    if (!market || market.kind !== 'spot') bad(`${symbol} is not a spot market on ${venue.venue.displayName}`);
    return { account, venue, market };
  }

  /** The venue's last traded price on `symbol`: the price a stop here is judged on. Null where it publishes none. */
  private async lastPrice(symbol: string): Promise<Amount | null> {
    const venue = await this.deps.door.venue();
    if (!venue.trades) return null;
    const prints = (await venue.trades(symbol, 1)).value;
    return prints[0]?.price ?? null;
  }

  async create(principal: Principal, req: SpotConditionalRequest, region = ''): Promise<SpotConditionalCreated> {
    const p = parse(req);
    const { account, venue, market } = await this.spotMarket(typeof req.owner === 'string' ? req.owner : '', p.symbol);
    for (const f of FIELDS) {
      const price = p.prices[f];
      if (price !== null && market.tickSize !== ZERO && price % market.tickSize !== ZERO)
        bad(`${FIELD_WORDS[f]} must be a multiple of the tick size (${formatAmount(market.tickSize)}) on ${p.symbol}`);
    }
    if (market.lotSize !== ZERO && p.quantity % market.lotSize !== ZERO)
      bad(`the size must be a multiple of the lot size (${formatAmount(market.lotSize)}) on ${p.symbol}`);
    const last = await this.lastPrice(p.symbol);
    const needsLast = p.kind === 'stop_limit' || p.kind === 'stop_market' || p.kind === 'oco';
    if (needsLast && last === null) {
      throw new SpotConditionalError(
        'trade.spot_conditional_no_reference',
        `${venue.venue.displayName} has no last trade on ${p.symbol} to judge a stop on yet, so nothing was placed`,
        400,
      );
    }
    assertOrder(p, last);

    // A stop the venue holds on spot rests there as its own trigger order, for the person's wallet to sign.
    if ((p.kind === 'stop_limit' || p.kind === 'stop_market') && spotStopRestsOn(market) === 'venue') {
      const trigger = p.prices.triggerPrice!;
      const answer = await this.deps.door.prepare(principal, {
        owner: account.owner,
        signer: { role: 'owner', address: account.owner },
        intent: {
          kind: 'place_order',
          symbol: p.symbol,
          side: p.side,
          type: p.kind === 'stop_limit' ? 'limit' : 'market',
          amount: p.quantity,
          price: p.kind === 'stop_limit' ? p.prices.limitPrice! : await this.deps.door.marketWorstPrice(p.symbol, p.side),
          timeInForce: p.kind === 'stop_limit' ? 'GTC' : 'IOC',
          reduceOnly: false,
          trigger: { price: trigger, source: 'last', role: 'stop_loss' },
          clientOrderKey: `spot-cond:${account.owner}:${p.clientOrderId}:venue`,
          builderFee: null,
        },
      });
      return { restsOn: 'venue', actionKey: answer.actionKey, prepared: answer.prepared, reused: answer.reused };
    }

    // Everything else runs on our engine: the orders it sends later are new orders, judged here as the door judges them.
    assertTradingLevel(principal, 'place_order');
    const agent = await this.agent(principal, account.owner);
    if (!agent.approved) {
      throw new SpotConditionalError(
        'trade.spot_agent_unapproved',
        `a ${KIND_WORDS[p.kind]} here runs on our engine, which needs your agent permission on ${venue.venue.displayName}: approve it in your wallet first`,
        409,
      );
    }
    const existing = (await this.deps.store.listForOwner(principal.userId, account.owner)).find((r) => r.clientKey === p.clientOrderId);
    if (existing && !sameTerms(existing, p, p.symbol)) {
      throw new SpotConditionalError(
        'trade.spot_conditional_key_reused',
        `client order id ${p.clientOrderId} already names another order on this account; nothing was placed`,
        409,
      );
    }
    if (!existing) await this.assertFree(account, market, p);
    const now = this.deps.now();
    const stored = await this.deps.store.createOnce({
      id: randomUUID(),
      userId: principal.userId,
      venueId: account.venueId,
      owner: account.owner,
      clientKey: p.clientOrderId,
      kind: p.kind,
      symbol: p.symbol,
      side: p.side,
      quantity: p.quantity,
      triggerPrice: p.prices.triggerPrice,
      limitPrice: p.prices.limitPrice,
      takeProfitPrice: p.prices.takeProfitPrice,
      entryPrice: p.prices.entryPrice,
      entryTif: p.entryTif,
      closePrice: p.prices.closePrice,
      exitQuantity: null,
      agentAddress: agent.agentAddress,
      region,
      status: p.kind === 'oco' ? 'placing' : p.kind === 'bracket' || p.kind === 'oto' ? 'entry' : 'armed',
      failure: null,
      cancelReason: null,
      firedAt: null,
      createdAt: now,
    });
    const reused = stored.createdAt.getTime() !== now.getTime() || existing !== undefined;
    let entry: PreparedAnswer | null = null;
    if (stored.kind === 'bracket' || stored.kind === 'oto') {
      // The entry is the person's own order, signed in their own wallet; our engine watches it on the venue.
      entry = await this.deps.door.prepare(principal, {
        owner: account.owner,
        signer: { role: 'owner', address: account.owner },
        intent: {
          kind: 'place_order',
          symbol: stored.symbol,
          side: stored.side,
          type: 'limit',
          amount: stored.quantity,
          price: stored.entryPrice!,
          timeInForce: stored.entryTif ?? 'GTC',
          reduceOnly: false,
          clientOrderKey: spotKeys.leg(stored, 'entry'),
          builderFee: null,
        },
      });
    }
    // An OCO's take profit goes to the venue now, under the agent permission: the one venue lock both legs share.
    if (stored.status === 'placing') await this.placeExit(stored);
    const now2 = (await this.deps.store.get(principal.userId, stored.id))!;
    return { restsOn: 'engine', conditional: await this.view(now2, new Map()), reused, entry };
  }

  /** What the venue account holds free now covers what this order will need when it is sent; nothing is locked. */
  private async assertFree(account: UserVenueAccount, market: UserVenueMarket, p: Parsed): Promise<void> {
    if (p.kind === 'bracket' || p.kind === 'oto') return; // the entry is the person's own order: the venue judges it
    const venue = await this.deps.door.venue();
    const balances = (await venue.balances(account)).value;
    const free = (asset: string) => balances.find((b) => b.asset === asset)?.free ?? ZERO;
    const asset = p.side === 'sell' ? market.baseAsset : market.quoteAsset;
    const price = p.prices.limitPrice ?? p.prices.triggerPrice!;
    const need = p.side === 'sell' ? p.quantity : mul(p.quantity, p.kind === 'oco' ? (p.prices.limitPrice ?? price) : price, 'ceil');
    if (compare(free(asset), need) < 0) {
      throw new SpotConditionalError(
        'trade.spot_conditional_insufficient',
        `this ${KIND_WORDS[p.kind]} needs ${formatAmount(need)} ${asset} free on the venue when it is sent, and ${formatAmount(free(asset))} is free; nothing was placed`,
        400,
      );
    }
  }

  /** The fees each leg would pay, from the venue's published schedule and our builder fee on a spot sell. */
  async review(principal: Principal, req: SpotConditionalRequest): Promise<{ readonly legs: readonly SpotFeeLeg[] }> {
    void principal;
    const p = parse(req);
    const { market } = await this.spotMarket(typeof req.owner === 'string' ? req.owner : '', p.symbol);
    const legs: { role: SpotLegRole; side: 'buy' | 'sell'; liquidity: 'maker' | 'taker'; price: Amount; quantity: Amount }[] = [];
    const exitSide = p.kind === 'bracket' ? other(p.side) : p.side;
    if (p.kind === 'bracket' || p.kind === 'oto')
      legs.push({
        role: 'entry',
        side: p.side,
        liquidity: p.entryTif === 'IOC' ? 'taker' : 'maker',
        price: p.prices.entryPrice!,
        quantity: p.quantity,
      });
    if (p.kind === 'oco' || p.kind === 'bracket') {
      legs.push({ role: 'take_profit', side: exitSide, liquidity: 'maker', price: p.prices.takeProfitPrice!, quantity: p.quantity });
      legs.push({
        role: 'stop_loss',
        side: exitSide,
        liquidity: 'taker',
        price: p.prices.limitPrice ?? p.prices.triggerPrice!,
        quantity: p.quantity,
      });
    }
    if (p.kind === 'oto')
      legs.push({ role: 'close', side: other(p.side), liquidity: 'maker', price: p.prices.closePrice!, quantity: p.quantity });
    if (p.kind === 'stop_limit' || p.kind === 'stop_market')
      legs.push({
        role: 'stop',
        side: p.side,
        liquidity: 'taker',
        price: p.prices.limitPrice ?? p.prices.triggerPrice!,
        quantity: p.quantity,
      });
    const out: SpotFeeLeg[] = [];
    for (const leg of legs) {
      const rate = leg.liquidity === 'maker' ? market.makerFeeBps : market.takerFeeBps;
      const builder = await this.deps.door.builderFeeFor(p.symbol, leg.side);
      const builderBps = builder === null ? null : builder.carries ? builder.feeBps : ZERO;
      // A spot buy pays its fees in the base it receives; a sell in the quote.
      const notional = leg.side === 'buy' ? leg.quantity : mul(leg.quantity, leg.price, 'ceil');
      const bps = rate.known && builderBps !== null ? add(rate.value, builderBps) : null;
      out.push({
        role: leg.role,
        side: leg.side,
        liquidity: leg.liquidity,
        price: formatAmount(leg.price),
        quantity: formatAmount(leg.quantity),
        venueFeeBps: rate.known ? formatAmount(rate.value) : null,
        builderFeeBps: fmt(builderBps),
        feeAsset: leg.side === 'buy' ? market.baseAsset : market.quoteAsset,
        estimatedFee: bps === null ? null : formatAmount(div(mul(notional, bps, 'ceil'), TEN_THOUSAND, 'ceil')),
      });
    }
    return { legs: out };
  }

  async list(principal: Principal, owner: string): Promise<readonly SpotConditionalView[]> {
    const account = await this.deps.door.account(owner);
    const prices = new Map<string, Amount | null>();
    const out: SpotConditionalView[] = [];
    for (const row of await this.deps.store.listForOwner(principal.userId, account.owner)) out.push(await this.view(row, prices));
    return out;
  }

  /**
   * The person cancels: a stop not fired is dropped (nothing rests on the venue); what rests there for it (an OCO's
   * take profit, a bracket's entry or exits, a linked close's entry) is cancelled on the venue, which releases its lock.
   */
  async cancel(principal: Principal, id: string): Promise<SpotConditionalView> {
    const row = await this.deps.store.get(principal.userId, id);
    if (!row) throw new SpotConditionalError('trade.spot_conditional_unknown', 'no conditional order with that id on your account', 404);
    const at = this.deps.now();
    if (row.status === 'armed' && (await this.deps.store.move(row.id, 'armed', 'cancelled', at, { cancelReason: 'cancelled' }))) {
      return this.view((await this.deps.store.get(principal.userId, id))!, new Map());
    }
    for (const from of ['open', 'placing', 'entry'] as const) {
      if (row.status === from && (await this.deps.store.move(row.id, from, 'cancelling', at, { cancelReason: 'cancelled' }))) {
        await this.finishCancel({ ...row, status: 'cancelling' });
        return this.view((await this.deps.store.get(principal.userId, id))!, new Map());
      }
    }
    const now = await this.deps.store.get(principal.userId, id);
    if (now?.status === 'cancelled' || now?.status === 'cancelling') return this.view(now, new Map());
    throw new SpotConditionalError('trade.spot_conditional_final', `that order is already ${now?.status ?? 'gone'}`, 409);
  }

  /** A live stop's trigger (and limit) changed by the person, judged as a new one would be. */
  async modify(principal: Principal, id: string, req: { triggerPrice?: unknown; limitPrice?: unknown }): Promise<SpotConditionalView> {
    const row = await this.deps.store.get(principal.userId, id);
    if (!row) throw new SpotConditionalError('trade.spot_conditional_unknown', 'no conditional order with that id on your account', 404);
    if (row.kind === 'oto') bad('a linked close has no stop to modify; cancel it instead');
    if (!['armed', 'open', 'entry', 'placing'].includes(row.status))
      throw new SpotConditionalError('trade.spot_conditional_final', `that order is already ${row.status}`, 409);
    const request: SpotConditionalRequest = {
      kind: row.kind,
      side: row.side,
      symbol: row.symbol,
      clientOrderId: row.clientKey,
      quantity: formatAmount(row.quantity),
      triggerPrice: req.triggerPrice,
      limitPrice: req.limitPrice ?? (row.kind === 'stop_limit' ? fmt(row.limitPrice) : undefined),
      takeProfitPrice: fmt(row.takeProfitPrice),
      entryPrice: fmt(row.entryPrice),
      entryTif: row.entryTif,
    };
    const p = parse(request);
    assertOrder(p, await this.lastPrice(row.symbol));
    if (!(await this.deps.store.reprice(row.id, row.status, p.prices.triggerPrice!, p.prices.limitPrice, this.deps.now())))
      throw new SpotConditionalError(
        'trade.spot_conditional_final',
        'that order moved on while it was being changed; nothing was changed',
        409,
      );
    return this.view((await this.deps.store.get(principal.userId, id))!, new Map());
  }

  /**
   * One pass of our engine over every live conditional: an entry that is final puts its exits up, a take profit's fill
   * ends its stop loss, a crossed stop is claimed by this worker alone and its one order sent, and a claim a stopped
   * worker left behind is finished under the same keys.
   */
  async tick(): Promise<{ readonly fired: number }> {
    let fired = 0;
    const prices = new Map<string, Amount | null>();
    for (const row of await this.deps.store.live()) {
      try {
        if (row.status === 'firing') await this.fire(row);
        else if (row.status === 'cancelling') await this.finishCancel(row);
        else if (row.status === 'placing') await this.placeExit(row);
        else if (row.status === 'entry') await this.watchEntry(row);
        else if (row.status === 'open' || row.status === 'armed') {
          if (row.status === 'open' && (await this.takeProfitEnded(row))) continue;
          const last = await this.cachedLast(prices, row.symbol);
          if (last === null || row.triggerPrice === null) continue;
          const exitSide = row.kind === 'bracket' ? other(row.side) : row.side;
          const crossed = exitSide === 'sell' ? compare(last, row.triggerPrice) <= 0 : compare(last, row.triggerPrice) >= 0;
          if (!crossed) continue;
          if (!(await this.deps.store.move(row.id, row.status, 'firing', this.deps.now()))) continue;
          fired += 1;
          await this.fire({ ...row, status: 'firing' });
        }
      } catch (err) {
        process.stderr.write(
          `${JSON.stringify({ level: 'warn', msg: 'trade.spot_conditional_engine.pass_failed', conditional: row.id, message: err instanceof Error ? err.message : String(err) })}\n`,
        );
      }
    }
    return { fired };
  }

  private async cachedLast(prices: Map<string, Amount | null>, symbol: string): Promise<Amount | null> {
    if (!prices.has(symbol)) prices.set(symbol, await this.lastPrice(symbol));
    return prices.get(symbol) ?? null;
  }

  /** The venue's record of one of this conditional's orders, by its key; null when no such order was ever prepared. */
  private async orderOf(row: SpotConditional, key: string): Promise<VenueOrderByKey | null> {
    try {
      return await this.deps.door.orderByKey(engineActor(row.userId, 'none'), key);
    } catch (err) {
      if (err instanceof UserVenueDoorError && err.code === 'trade.venue_action_unknown') return null;
      throw err;
    }
  }

  /** The take-profit (or close) key of an OCO-like conditional. */
  private exitKey(row: SpotConditional) {
    return spotKeys.leg(row, row.kind === 'oto' ? 'close' : 'tp');
  }

  /** An OCO's take profit filled whole or ended on the venue: the stop loss ends with it, once. True when it ended. */
  private async takeProfitEnded(row: SpotConditional): Promise<boolean> {
    const tp = await this.orderOf(row, this.exitKey(row));
    const order = tp?.state === 'accepted' ? tp.order : null;
    if (!order || !FINAL.has(order.status)) return false;
    const at = this.deps.now();
    if (order.status === 'filled') await this.deps.store.move(row.id, 'open', 'filled', at, { firedAt: at });
    else await this.deps.store.move(row.id, 'open', 'cancelled', at, { cancelReason: 'take_profit_ended' });
    return true;
  }

  /** A bracket's or linked close's entry, as the venue reads it: once final, its exits go up for what it received. */
  private async watchEntry(row: SpotConditional): Promise<void> {
    const entry = await this.orderOf(row, spotKeys.leg(row, 'entry'));
    if (!entry || entry.state === 'not_sent' || entry.state === 'unknown') return;
    const at = this.deps.now();
    if (entry.state === 'refused') {
      await this.deps.store.move(row.id, 'entry', 'failed', at, {
        failure: `the venue refused the entry (${entry.refusal?.detail ?? 'no reason given'}), so no exit was placed`,
      });
      return;
    }
    const order = entry.order;
    if (!order || !FINAL.has(order.status)) return; // a resting entry waits
    const received = await this.received(row, order);
    if (received === ZERO) {
      await this.deps.store.move(row.id, 'entry', 'cancelled', at, { cancelReason: 'entry_filled_nothing' });
      return;
    }
    if (await this.deps.store.move(row.id, 'entry', 'placing', at, { exitQuantity: received }))
      await this.placeExit({ ...row, status: 'placing', exitQuantity: received });
  }

  /** What the entry received, net of fees paid in it, on the market's lot: the size its exits close. */
  private async received(row: SpotConditional, order: UserVenueOrder): Promise<Amount> {
    if (order.filled === ZERO) return ZERO;
    const venue = await this.deps.door.venue();
    const account: UserVenueAccount = { venueId: row.venueId, owner: row.owner, subAccount: null };
    const market = (await venue.markets(account)).value.find((m) => m.symbol === row.symbol);
    const lot = market?.lotSize ?? ZERO;
    if (row.side === 'sell') return floorTo(order.filled, lot);
    const base = market?.baseAsset ?? '';
    const since = new Date(row.createdAt.getTime() - 60_000);
    const fees = (await venue.fills(account, since)).value
      .filter((f) => f.venueClientOrderId === order.venueClientOrderId && f.feeAsset === base)
      .reduce((s, f) => add(s, add(f.venueFee, f.builderFee)), ZERO);
    const net = sub(order.filled, fees);
    return compare(net, ZERO) > 0 ? floorTo(net, lot) : ZERO;
  }

  /** Puts the exit up on the venue under the agent key: an OCO's take profit, or a linked close. */
  private async placeExit(row: SpotConditional): Promise<void> {
    const size = row.exitQuantity ?? row.quantity;
    const exitSide = row.kind === 'oco' ? row.side : other(row.side);
    const price = row.kind === 'oto' ? row.closePrice! : row.takeProfitPrice!;
    const result = await this.sendAsAgent(row, {
      kind: 'place_order',
      symbol: row.symbol,
      side: exitSide,
      type: 'limit',
      amount: size,
      price,
      timeInForce: 'GTC',
      reduceOnly: false,
      clientOrderKey: this.exitKey(row),
      builderFee: null,
    });
    const at = this.deps.now();
    if (result.kind === 'pending') return; // read back by its key on the next pass
    if (result.kind === 'refused') {
      await this.deps.store.move(row.id, 'placing', 'failed', at, {
        failure: `the venue refused the ${row.kind === 'oto' ? 'close' : 'take profit'}: ${result.detail}`,
      });
      return;
    }
    // A linked close is sent once and is then an order of its own; an OCO's pair is open.
    await this.deps.store.move(row.id, 'placing', row.kind === 'oto' ? 'fired' : 'open', at, row.kind === 'oto' ? { firedAt: at } : {});
  }

  /** The cancel the person asked for, finished on the venue: whatever rests there for this order is cancelled. */
  private async finishCancel(row: SpotConditional): Promise<void> {
    const keys = [this.exitKey(row), spotKeys.leg(row, 'entry')];
    for (const key of keys) {
      const read = await this.orderOf(row, key);
      if (!read || read.state !== 'accepted' || !read.order || FINAL.has(read.order.status)) {
        if (read && (read.state === 'unknown' || (read.state === 'accepted' && !read.order))) return; // not settled yet
        continue;
      }
      const done = await this.cancelOnVenue(row, key);
      if (!done) return;
    }
    await this.deps.store.move(row.id, 'cancelling', 'cancelled', this.deps.now());
  }

  /** One cancel of the venue order under `key`, signed by the agent key: true once the venue has answered it. */
  private async cancelOnVenue(row: SpotConditional, key: string): Promise<boolean> {
    const result = await this.sendAsAgent(row, { kind: 'cancel_order', symbol: row.symbol, clientOrderKey: key });
    return result.kind !== 'pending';
  }

  /**
   * The one order of a claimed stop. For an OCO it first cancels the take profit (releasing its venue lock), then sends
   * the stop loss for what the take profit did not fill. Stored under its key before it is sent.
   */
  private async fire(row: SpotConditional): Promise<void> {
    const key = spotKeys.fire(row);
    const sent = await this.orderOf(row, key);
    if (sent && sent.state === 'accepted' && sent.order) return this.settle(row, sent.order, null);
    if (sent && sent.state === 'refused') return this.settle(row, null, sent.refusal?.detail ?? 'the venue refused the order');
    let size = row.quantity;
    const exitSide = row.kind === 'bracket' ? other(row.side) : row.side;
    if (row.kind === 'oco' || row.kind === 'bracket') {
      const tpKey = this.exitKey(row);
      const tp = await this.orderOf(row, tpKey);
      if (tp?.state === 'accepted' && tp.order && !FINAL.has(tp.order.status)) {
        if (!(await this.cancelOnVenue(row, tpKey))) return;
      }
      const after = await this.orderOf(row, tpKey);
      if (after?.state === 'unknown') return;
      const tpFilled = after?.state === 'accepted' && after.order ? after.order.filled : ZERO;
      size = sub(row.exitQuantity ?? row.quantity, tpFilled);
      if (compare(size, ZERO) <= 0) {
        await this.deps.store.move(row.id, 'firing', 'filled', this.deps.now(), { firedAt: this.deps.now() });
        return;
      }
    }
    const limit = row.limitPrice;
    const intent: PlaceUserOrderIntent = {
      kind: 'place_order',
      symbol: row.symbol,
      side: exitSide,
      type: limit === null ? 'market' : 'limit',
      amount: size,
      // A market order's worst price is the owner's protection, read when it is first prepared (sendAsAgent).
      price: limit ?? ZERO,
      timeInForce: limit === null ? 'IOC' : 'GTC',
      reduceOnly: false,
      clientOrderKey: key,
      builderFee: null,
    };
    const result = await this.sendAsAgent(row, intent);
    if (result.kind === 'pending') return;
    if (result.kind === 'refused') return this.settle(row, null, result.detail);
    return this.settle(row, result.order, null);
  }

  private async settle(row: SpotConditional, order: UserVenueOrder | null, refusal: string | null): Promise<void> {
    const at = this.deps.now();
    // A stop-limit's limit order that rests is sent; a market order that filled nothing failed.
    if (order && (order.filled !== ZERO || (order.type === 'limit' && !FINAL.has(order.status)) || order.status === 'filled')) {
      await this.deps.store.move(row.id, 'firing', 'fired', at, { firedAt: at });
      return;
    }
    const failure = refusal ?? `the venue filled nothing of the order our engine sent (${order?.status ?? 'no answer'})`;
    await this.deps.store.move(row.id, 'firing', 'failed', at, { firedAt: at, failure });
  }

  /**
   * One action on the person's venue account signed by the spot-order key, after the person's level, freeze and region
   * are read again. `pending` when the venue has not answered definitely: the same key is sent again on the next pass.
   */
  private async sendAsAgent(
    row: SpotConditional,
    intent: PlaceUserOrderIntent | { kind: 'cancel_order'; symbol: string; clientOrderKey: string },
  ): Promise<{ kind: 'done'; order: UserVenueOrder | null } | { kind: 'refused'; detail: string } | { kind: 'pending' }> {
    if (!this.deps.liveTier) throw new Error('the verification level cannot be read here, so our engine sends no order');
    if (!this.deps.freeze) throw new Error('the account freeze cannot be read here, so our engine sends no order');
    const tier = await this.deps.liveTier(row.userId);
    if (intent.kind === 'place_order') {
      if (await this.deps.freeze.frozen(row.userId))
        return { kind: 'refused', detail: 'your account is frozen, so our engine sent no order' };
      try {
        assertPlaceEligible({ tier, region: row.region });
      } catch (err) {
        if (err instanceof AuthError)
          return { kind: 'refused', detail: `your verification level no longer allows an order (${err.message})` };
        if (err instanceof JurisdictionError)
          return { kind: 'refused', detail: `trading is no longer allowed for this account (${err.message}), so nothing was sent` };
        throw err;
      }
    }
    const actor = engineActor(row.userId, tier);
    const signer = this.spotKey(row.userId, row.owner);
    // An action already stored under its key is sent as it was stored (a stop-market's worst price is read once, when it
    // was first prepared): never a second, different action under the same key.
    const key = intent.kind === 'cancel_order' ? `cancel:${intent.clientOrderKey}` : intent.clientOrderKey;
    const stored = await this.deps.door.stored(actor, key);
    let answer: Pick<PreparedAnswer, 'actionKey' | 'prepared' | 'signed' | 'lastOutcome'>;
    try {
      answer = stored
        ? { actionKey: stored.businessKey, prepared: stored.prepared, signed: stored.signature !== null, lastOutcome: stored.lastOutcome }
        : await this.deps.door.prepare(actor, {
            owner: row.owner,
            signer: { role: 'agent', address: signer.address.toLowerCase() },
            intent:
              intent.kind === 'place_order' && intent.type === 'market' && intent.price === ZERO
                ? { ...intent, price: await this.deps.door.marketWorstPrice(intent.symbol, intent.side) }
                : intent,
          });
    } catch (err) {
      if (err instanceof AuthError)
        return { kind: 'refused', detail: `your verification level no longer allows an order (${err.message})` };
      if (err instanceof VenueRefusalError) return { kind: 'refused', detail: err.refusal.detail };
      throw err;
    }
    if (answer.signed && answer.lastOutcome?.definite) return outcomeOf(answer.lastOutcome);
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
      if (err instanceof VenueRefusalError) return { kind: 'refused', detail: err.refusal.detail };
      throw err;
    }
    return outcomeOf(outcome);
  }

  /** One conditional as the person sees it: each leg with where it rests and what the venue reads for it now. */
  private async view(row: SpotConditional, prices: Map<string, Amount | null>): Promise<SpotConditionalView> {
    const live = ['entry', 'placing', 'open', 'armed', 'firing', 'cancelling'].includes(row.status);
    const last = live ? await this.cachedLast(prices, row.symbol) : null;
    const exitSide = row.kind === 'bracket' || row.kind === 'oto' ? other(row.side) : row.side;
    const legs: SpotLegView[] = [];
    const venueLeg = async (
      role: SpotLegRole,
      key: string,
      side: 'buy' | 'sell',
      price: Amount,
      size: Amount,
      signedBy: 'wallet' | 'agent',
      linkedTo: SpotLegRole | null,
    ) => {
      const read = await this.orderOf(row, key).catch(() => null);
      const order = read?.state === 'accepted' ? read.order : null;
      const status: SpotLegStatus = order
        ? order.status === 'filled'
          ? 'filled'
          : order.status === 'partially_filled'
            ? 'partially_filled'
            : FINAL.has(order.status)
              ? order.filled !== ZERO
                ? 'partially_filled'
                : 'cancelled'
              : order.filled !== ZERO
                ? 'partially_filled'
                : 'open'
        : read?.state === 'refused'
          ? 'failed'
          : row.status === 'cancelled' || row.status === 'failed'
            ? 'cancelled'
            : 'waiting';
      legs.push({
        role,
        side,
        type: 'limit',
        price: formatAmount(price),
        triggerPrice: null,
        quantity: formatAmount(size),
        restsOn: 'venue',
        signedBy,
        status,
        orderKey: key,
        venueClientOrderId: order?.venueClientOrderId ?? read?.venueClientOrderId ?? null,
        filled: order ? formatAmount(order.filled) : null,
        locked: order ? formatAmount(order.locked) : null,
        lockedAsset: order?.lockedAsset ?? null,
        linkedTo,
      });
      return order;
    };
    const engineLeg = async (role: SpotLegRole, size: Amount) => {
      const sent =
        row.status === 'fired' || row.status === 'failed' || row.status === 'firing'
          ? await this.orderOf(row, spotKeys.fire(row)).catch(() => null)
          : null;
      const order = sent?.state === 'accepted' ? sent.order : null;
      const status: SpotLegStatus =
        row.status === 'armed' || row.status === 'open'
          ? 'armed'
          : row.status === 'firing'
            ? 'triggered'
            : row.status === 'fired'
              ? order && order.status !== 'filled' && !FINAL.has(order.status)
                ? 'open'
                : 'filled'
              : row.status === 'failed'
                ? 'failed'
                : row.status === 'entry' || row.status === 'placing'
                  ? 'waiting'
                  : 'cancelled';
      legs.push({
        role,
        side: exitSide,
        type: row.limitPrice === null ? 'market' : 'limit',
        price: fmt(row.limitPrice),
        triggerPrice: fmt(row.triggerPrice),
        quantity: formatAmount(size),
        restsOn: 'engine',
        signedBy: 'agent',
        status,
        orderKey: order ? spotKeys.fire(row) : null,
        venueClientOrderId: order?.venueClientOrderId ?? null,
        filled: order ? formatAmount(order.filled) : null,
        locked: order ? formatAmount(order.locked) : null,
        lockedAsset: order?.lockedAsset ?? null,
        linkedTo: role === 'stop_loss' ? 'take_profit' : null,
      });
    };
    if (row.kind === 'stop_limit' || row.kind === 'stop_market') await engineLeg('stop', row.quantity);
    if (row.kind === 'bracket' || row.kind === 'oto')
      await venueLeg('entry', spotKeys.leg(row, 'entry'), row.side, row.entryPrice!, row.quantity, 'wallet', null);
    if (row.kind === 'oco' || row.kind === 'bracket') {
      const size = row.exitQuantity ?? row.quantity;
      const tp = await venueLeg(
        'take_profit',
        spotKeys.leg(row, 'tp'),
        exitSide,
        row.takeProfitPrice!,
        size,
        'agent',
        row.kind === 'bracket' ? 'entry' : null,
      );
      // The stop loss covers what the take profit has not filled.
      await engineLeg('stop_loss', tp ? sub(size, tp.filled) : size);
    }
    if (row.kind === 'oto')
      await venueLeg('close', spotKeys.leg(row, 'close'), exitSide, row.closePrice!, row.exitQuantity ?? row.quantity, 'agent', 'entry');
    return {
      id: row.id,
      clientOrderId: row.clientKey,
      kind: row.kind,
      symbol: row.symbol,
      side: row.side,
      quantity: formatAmount(row.quantity),
      status: row.status,
      restsOn: 'engine',
      label: SPOT_ENGINE_LABEL,
      agentPermission: { agentAddress: row.agentAddress },
      triggerSource: 'last',
      triggerPrice: fmt(row.triggerPrice),
      limitPrice: fmt(row.limitPrice),
      takeProfitPrice: fmt(row.takeProfitPrice),
      entryPrice: fmt(row.entryPrice),
      entryTif: row.entryTif,
      closePrice: fmt(row.closePrice),
      exitQuantity: fmt(row.exitQuantity),
      referencePrice: fmt(last),
      failure: row.failure,
      cancelReason: row.cancelReason,
      createdAt: row.createdAt.toISOString(),
      legs,
    };
  }
}

function outcomeOf(
  outcome: VenueSubmitOutcome,
): { kind: 'done'; order: UserVenueOrder | null } | { kind: 'refused'; detail: string } | { kind: 'pending' } {
  if (!outcome.definite) return { kind: 'pending' };
  if (!outcome.accepted) return { kind: 'refused', detail: outcome.refusal.detail };
  return { kind: 'done', order: outcome.order ?? null };
}
