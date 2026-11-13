import { randomUUID } from 'node:crypto';
import { keccak256, toHex, type TypedDataDefinition } from 'viem';
import { privateKeyToAccount, type PrivateKeyAccount } from 'viem/accounts';
import { add, compare, div, formatAmount, max, min, mul, parseAmount, sub, ZERO, type Amount } from '@intafaced/ledger-client/money';
import { AuthError, type Principal } from '@intafaced/auth';
import {
  VenueRefusalError,
  type PlaceUserOrderIntent,
  type UserVenueAccount,
  type UserVenueMarket,
  type UserVenueOrder,
  type VenueSubmitOutcome,
} from '@intafaced/venue-contracts';
import type { EngineProtection, EngineProtectionStore } from './protection-store.js';
import { assertTradingLevel, type PreparedAnswer, type UserVenueDoor, type VenueOrderByKey } from './user-venue-door.js';

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
 * claimed (`armed` → `firing`) by exactly one worker; its order is stored under `protection:fire:<id>` before it is sent,
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
  | 'trade.protection_final';

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

/** A fired market exit's worst price, from its trigger: 5% past it, the same slippage limit the desk's Close uses. */
const EXIT_SLIPPAGE_PERCENT = 5n;

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

export interface ProtectionsDeps {
  readonly door: UserVenueDoor;
  readonly store: EngineProtectionStore;
  /** `TRADE_AGENT_KEY_SEED`: the owner's secret the protection key derives from. Blank refuses every engine stop. */
  readonly keySeed: string;
  /**
   * The person's verification level as identity holds it now (signals/live-tier.ts), read before each order our engine
   * sends, so a stop never trades on a level the person no longer has. Null, or a read that fails, sends nothing.
   */
  readonly liveTier: ((userId: string) => Promise<Principal['tier']>) | null;
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

const onTick = (price: Amount, tick: Amount, up: boolean): Amount => {
  if (tick === ZERO) return price;
  const down = price - (price % tick);
  return up && down !== price ? add(down, tick) : down;
};

/** A sell's worst price below its trigger, a buy's above, on the market's tick. */
function worstPrice(side: 'buy' | 'sell', from: Amount, tick: Amount): Amount {
  const raw =
    side === 'sell'
      ? div(mul(from, parseAmount(String(100n - EXIT_SLIPPAGE_PERCENT))), parseAmount('100'), 'floor')
      : div(mul(from, parseAmount(String(100n + EXIT_SLIPPAGE_PERCENT))), parseAmount('100'), 'ceil');
  return onTick(raw, tick, side === 'buy');
}

const sourceWords = (s: ProtectionSource) => (s === 'mark' ? 'mark price' : s === 'last' ? 'last traded price' : 'index price');

/**
 * A principal for the engine acting on one person's own venue account: their user id, trading scopes only, and their
 * level exactly as identity answered it for this order, never one made up here. A read by key takes `none`.
 */
function engineActor(userId: string, tier: Principal['tier']): Principal {
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
    return this.deps.door.prepare(principal, {
      owner: account.owner,
      signer: { role: 'owner', address: account.owner },
      intent: { kind: 'approve_agent', agentAddress: address, agentName: PROTECTION_AGENT_NAME, validUntil: null },
      actionKey: `protection-agent:${account.owner}:${address}`,
    });
  }

  async create(principal: Principal, req: ProtectionRequest): Promise<ProtectionCreated> {
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
        price: kind === 'stop_limit' ? (limitPrice as Amount) : worstPrice(side, triggerPrice as Amount, market.tickSize),
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
        signer: { role: 'owner', address: account.owner },
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
      status: 'armed',
      failure: null,
      cancelReason: null,
      firedAt: null,
      createdAt: now,
    });
    return { restsOn: 'engine', protection: engineView(stored, null) };
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
          ? await this.deps.door.orderByKey(engineActor(row.userId, 'none'), fireKey(row))
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
      price: worstPrice(row.side, market.mark.value, market.tickSize),
      timeInForce: 'IOC',
      reduceOnly: true,
      clientOrderKey: key,
      builderFee: null,
    };
    // The person's level now, from identity: a read that fails sends nothing and leaves the stop claimed, sent on a later
    // pass under the same key; a level below trading is refused by the door, and the stop fails in its words.
    if (!this.deps.liveTier) throw new Error('the verification level cannot be read here, so our engine sends no order');
    const actor = engineActor(row.userId, await this.deps.liveTier(row.userId));
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

const fireKey = (row: EngineProtection) => `protection:fire:${row.id}`;

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
