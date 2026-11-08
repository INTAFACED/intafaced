import { add, compare, div, max, min, mul, parseAmount, sub, ZERO, type Amount } from '@intafaced/ledger-client/money';
import {
  VenueRefusalError,
  assertSignatureMatches,
  assertSignerMaySign,
  venueClientOrderId,
  type AsOf,
  type MaybeKnown,
  type PlaceUserOrderIntent,
  type PreparedVenueAction,
  type UserVenue,
  type UserVenueAccount,
  type UserVenueAgent,
  type UserVenueBalance,
  type UserVenueDescriptor,
  type UserVenueFill,
  type UserVenueMarket,
  type UserVenueOrder,
  type UserVenuePosition,
  type UserVenueWithdrawal,
  type VenueIntent,
  type VenueMarginMode,
  type VenueRefusalCode,
  type VenueSignature,
  type VenueSigner,
  type VenueSubmitOutcome,
} from '@intafaced/venue-contracts';
import { buildTypedData, digestOf, recoverSigner, type TestVenueTypedData } from './signing.js';

/**
 * THE TEST VENUE SIMULATOR — a deterministic venue the customer's own wallet signs on.
 *
 * Every figure it reports is TEST (proof level `simulator`), and
 * `refuseTestVenueOutsideTest` refuses it outside APP_ENV dev or test. It is
 * the venue's record for its accounts, in memory: balances and locks, a
 * price-time book per market, fills with the venue's fee and our builder fee as
 * separate lines, isolated-margin perpetual positions, withdrawals, builder-fee
 * approvals and agent keys. It holds nothing of ours and posts nothing to our
 * ledger.
 *
 * Deterministic: the clock is injected, ids are counters, and there is no
 * randomness, so a CI shard replays the same run every time.
 *
 * Switches (CUSTODY-DELTA §4), each set through `switches`:
 *   · `venueDown` — every call refuses `venue_down`, nothing changes;
 *   · a market's `orderTypes` / `timeInForce` / `marginModes` — anything not
 *     listed refuses `not_offered` at prepare, before the wallet is asked;
 *   · `makerFeeBps` / `takerFeeBps` `known: false` — the fee is not published;
 *   · `withdrawalFee` `known: false` — the withdrawal fee is shown as not known;
 *   · an agent key is always refused a withdrawal (`agent_not_permitted`);
 *   · `loseAnswers` — the next N submits are applied and then answered
 *     `definite: false`, so a caller's read-back is exercised.
 */

const BPS = parseAmount('10000');
const QUOTE_ROUND = 'ceil' as const;

export interface SimMarketConfig {
  readonly symbol: string;
  readonly kind: 'spot' | 'perpetual';
  readonly baseAsset: string;
  readonly quoteAsset: string;
  readonly orderTypes: UserVenueMarket['orderTypes'];
  readonly timeInForce: UserVenueMarket['timeInForce'];
  readonly marginModes: readonly VenueMarginMode[];
  readonly maxLeverageBps: number | null;
  readonly tickSize: Amount;
  readonly lotSize: Amount;
  readonly makerFeeBps: MaybeKnown<Amount>;
  readonly takerFeeBps: MaybeKnown<Amount>;
  /** Perpetuals: maintenance margin as a fraction of notional (scaled decimal, `parseAmount('0.005')`). */
  readonly maintenanceMarginRate?: Amount;
  /** Perpetuals: the starting mark price. */
  readonly markPrice?: Amount;
}

export interface SimSwitches {
  venueDown: boolean;
  withdrawalFee: MaybeKnown<Amount>;
  /** The fee actually charged when `withdrawalFee` is not published. */
  unpublishedWithdrawalFee: Amount;
  loseAnswers: number;
}

export interface SimOptions {
  readonly id?: string;
  readonly displayName?: string;
  readonly clock: () => Date;
  readonly markets: readonly SimMarketConfig[];
  readonly switches?: Partial<SimSwitches>;
}

interface AccountState {
  readonly key: string;
  readonly owner: string;
  readonly balances: Map<string, { free: Amount; locked: Amount }>;
  readonly orders: Map<string, OrderState>; // by venue client order id
  readonly fills: UserVenueFill[];
  readonly positions: Map<string, PositionState>;
  readonly withdrawals: Map<string, UserVenueWithdrawal>; // by nonce
  readonly builderApprovals: Map<string, Amount>;
  readonly agents: Map<string, UserVenueAgent>;
  readonly deposits: Set<string>;
  readonly leverage: Map<string, { leverageBps: number; marginMode: VenueMarginMode }>;
}

interface OrderState {
  order: UserVenueOrder;
  readonly account: AccountState;
  readonly seq: number;
  readonly builderFee: { readonly builder: string; readonly feeBps: Amount } | null;
  readonly leverageBps: number | null;
  readonly marginMode: VenueMarginMode | null;
  /** Margin locked per unit of size for a perp order (initial margin at the order's price). */
  readonly marginPerUnit: Amount;
}

interface PositionState {
  side: 'long' | 'short';
  size: Amount;
  entryPrice: Amount;
  margin: Amount;
  leverageBps: number;
  marginMode: VenueMarginMode;
}

interface SubmittedRecord {
  readonly digest: string;
  readonly outcome: VenueSubmitOutcome;
}

function refuse(venueId: string, code: VenueRefusalCode, detail: string): never {
  throw new VenueRefusalError({ venueId, code, detail });
}

function accountKey(account: UserVenueAccount): string {
  return `${account.owner.toLowerCase()}/${account.subAccount ?? ''}`;
}

export class TestVenueSimulator implements UserVenue {
  readonly venue: UserVenueDescriptor;
  readonly switches: SimSwitches;
  private readonly clock: () => Date;
  private readonly marketsBySymbol = new Map<string, SimMarketConfig>();
  private readonly marks = new Map<string, Amount>();
  private readonly accounts = new Map<string, AccountState>();
  private readonly submitted = new Map<string, Map<string, SubmittedRecord>>(); // account → nonce → record
  private readonly book = new Map<string, OrderState[]>(); // symbol → resting orders
  private nonceCounter = 0;
  private seqCounter = 0;
  private fillCounter = 0;
  private venueOrderCounter = 0;

  constructor(options: SimOptions) {
    const id = options.id ?? 'test-venue-sim';
    this.venue = {
      id,
      displayName: options.displayName ?? 'TEST venue simulator',
      kind: 'external-dex',
      sequencedDepth: true,
      proofLevel: 'simulator',
    };
    this.clock = options.clock;
    this.switches = {
      venueDown: false,
      withdrawalFee: { known: true, value: parseAmount('1') },
      unpublishedWithdrawalFee: ZERO,
      loseAnswers: 0,
      ...options.switches,
    };
    for (const market of options.markets) {
      this.marketsBySymbol.set(market.symbol, market);
      this.book.set(market.symbol, []);
      if (market.markPrice !== undefined) this.marks.set(market.symbol, market.markPrice);
    }
  }

  // ── test controls (the simulator's own levers; never part of UserVenue) ──

  /**
   * Credit a deposit the customer signed on their own chain. Idempotent by
   * `depositRef` (the chain transfer's id): a replayed deposit adds nothing.
   * Returns true when it credited.
   */
  deposit(account: UserVenueAccount, asset: string, amount: Amount, depositRef: string): boolean {
    const state = this.account(account);
    if (state.deposits.has(depositRef)) return false;
    state.deposits.add(depositRef);
    const balance = this.balance(state, asset);
    balance.free = add(balance.free, amount);
    return true;
  }

  /** Move a perpetual's mark price. */
  setMark(symbol: string, price: Amount): void {
    this.marks.set(symbol, price);
  }

  /** Settle every pending withdrawal (the chain confirmed it). */
  settleWithdrawals(): number {
    let settled = 0;
    for (const state of this.accounts.values()) {
      for (const [nonce, withdrawal] of state.withdrawals) {
        if (withdrawal.status === 'pending') {
          state.withdrawals.set(nonce, { ...withdrawal, status: 'done' });
          settled += 1;
        }
      }
    }
    return settled;
  }

  // ── UserVenue: market reads ────────────────────────────────────────────

  async markets(_account: UserVenueAccount | null): Promise<AsOf<readonly UserVenueMarket[]>> {
    this.up();
    const list: UserVenueMarket[] = [...this.marketsBySymbol.values()].map((m) => ({
      symbol: m.symbol,
      kind: m.kind,
      baseAsset: m.baseAsset,
      quoteAsset: m.quoteAsset,
      orderTypes: m.orderTypes,
      timeInForce: m.timeInForce,
      marginModes: m.marginModes,
      maxLeverageBps: m.maxLeverageBps,
      tickSize: m.tickSize,
      lotSize: m.lotSize,
      makerFeeBps: m.makerFeeBps,
      takerFeeBps: m.takerFeeBps,
    }));
    return this.asOf(list);
  }

  // ── UserVenue: signed actions ──────────────────────────────────────────

  async prepare(account: UserVenueAccount, signer: VenueSigner, intent: VenueIntent): Promise<PreparedVenueAction> {
    this.up();
    if (account.venueId !== this.venue.id)
      refuse(this.venue.id, 'venue_rejected', `account is on ${account.venueId}, not ${this.venue.id}`);
    assertSignerMaySign(account, signer, intent);
    const state = this.account(account);
    if (signer.role === 'agent' && !state.agents.has(signer.address.toLowerCase())) {
      refuse(this.venue.id, 'signer_not_authorised', `${signer.address.toLowerCase()} is not an approved agent on this account`);
    }

    let cloid: string | null = null;
    let builderFee: PreparedVenueAction['builderFee'] = null;
    if (intent.kind === 'place_order') {
      this.checkOrderOnItsFace(state, intent);
      cloid = venueClientOrderId(this.venue.id, intent.clientOrderKey);
      if (intent.builderFee) {
        const approved = state.builderApprovals.get(intent.builderFee.builder.toLowerCase()) ?? ZERO;
        if (compare(approved, intent.builderFee.feeBps) < 0) {
          refuse(
            this.venue.id,
            'builder_fee_not_approved',
            `this account has approved ${approved} bps for the builder; the order carries more`,
          );
        }
        builderFee = { builder: intent.builderFee.builder.toLowerCase(), feeBps: intent.builderFee.feeBps };
      }
    } else if (intent.kind === 'update_leverage') {
      this.checkLeverageOnItsFace(intent.symbol, intent.leverageBps, intent.marginMode);
    } else if (intent.kind === 'withdraw' && account.subAccount !== null) {
      refuse(this.venue.id, 'not_offered', 'a withdrawal from a sub-account is not offered: move the funds to the main account first');
    } else if (intent.kind === 'amend_order' || intent.kind === 'cancel_order') {
      this.market(intent.symbol);
      cloid = venueClientOrderId(this.venue.id, intent.clientOrderKey);
    }

    this.nonceCounter += 1;
    const nonce = String(this.clock().getTime() * 1000 + (this.nonceCounter % 1000));
    const typedData = buildTypedData(this.venue.id, account, signer, intent, nonce);
    return {
      venueId: this.venue.id,
      account,
      signer,
      intent,
      nonce,
      venueClientOrderId: cloid,
      typedData,
      digest: digestOf(typedData),
      builderFee,
      preparedAt: this.clock(),
    };
  }

  async submit(prepared: PreparedVenueAction, signature: VenueSignature): Promise<VenueSubmitOutcome> {
    this.up();
    assertSignatureMatches(prepared, signature);
    // Recompute: the prepared action may have been edited after prepare.
    const typedData = buildTypedData(this.venue.id, prepared.account, prepared.signer, prepared.intent, prepared.nonce);
    const digest = digestOf(typedData);
    if (digest.toLowerCase() !== prepared.digest.toLowerCase()) {
      refuse(this.venue.id, 'signature_mismatch', 'the prepared action does not match its own digest');
    }
    const recovered = await recoverSigner(prepared.typedData as TestVenueTypedData, signature.signature);
    if (recovered !== prepared.signer.address.toLowerCase()) {
      refuse(
        this.venue.id,
        'signature_mismatch',
        `the signature was made by ${recovered ?? 'no valid key'}, not ${prepared.signer.address.toLowerCase()}`,
      );
    }

    const key = accountKey(prepared.account);
    const byNonce = this.submitted.get(key) ?? new Map<string, SubmittedRecord>();
    this.submitted.set(key, byNonce);
    const seen = byNonce.get(prepared.nonce);
    if (seen) {
      if (seen.digest !== digest) refuse(this.venue.id, 'venue_rejected', `nonce ${prepared.nonce} was already used for another action`);
      return seen.outcome;
    }

    const outcome = this.apply(prepared);
    byNonce.set(prepared.nonce, { digest, outcome });
    if (this.switches.loseAnswers > 0) {
      this.switches.loseAnswers -= 1;
      return { definite: false, reason: 'timeout' };
    }
    return outcome;
  }

  // ── UserVenue: account reads ───────────────────────────────────────────

  async balances(account: UserVenueAccount): Promise<AsOf<readonly UserVenueBalance[]>> {
    this.up();
    const state = this.account(account);
    const list = [...state.balances.entries()]
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([asset, b]) => ({ asset, free: b.free, locked: b.locked, total: add(b.free, b.locked) }));
    return this.asOf(list);
  }

  async openOrders(account: UserVenueAccount): Promise<AsOf<readonly UserVenueOrder[]>> {
    this.up();
    const state = this.account(account);
    const open = [...state.orders.values()]
      .filter((o) => o.order.status === 'open' || o.order.status === 'partially_filled')
      .sort((a, b) => a.seq - b.seq)
      .map((o) => o.order);
    return this.asOf(open);
  }

  async orderByClientId(account: UserVenueAccount, cloid: string): Promise<AsOf<UserVenueOrder | null>> {
    this.up();
    return this.asOf(this.account(account).orders.get(cloid)?.order ?? null);
  }

  async fills(account: UserVenueAccount, since: Date): Promise<AsOf<readonly UserVenueFill[]>> {
    this.up();
    return this.asOf(this.account(account).fills.filter((f) => f.filledAt.getTime() >= since.getTime()));
  }

  async positions(account: UserVenueAccount): Promise<AsOf<readonly UserVenuePosition[]>> {
    this.up();
    const state = this.account(account);
    const list: UserVenuePosition[] = [];
    for (const [symbol, p] of [...state.positions.entries()].sort(([a], [b]) => a.localeCompare(b))) {
      if (p.size === ZERO) continue;
      const market = this.market(symbol);
      const mark = this.marks.get(symbol) ?? p.entryPrice;
      list.push({
        symbol,
        side: p.side,
        size: p.size,
        entryPrice: p.entryPrice,
        markPrice: mark,
        unrealisedPnl: this.pnl(p, mark, p.size),
        marginMode: p.marginMode,
        margin: p.margin,
        leverageBps: p.leverageBps,
        liquidationPrice: this.liquidationPrice(market, p),
      });
    }
    return this.asOf(list);
  }

  async withdrawal(account: UserVenueAccount, nonce: string): Promise<AsOf<UserVenueWithdrawal | null>> {
    this.up();
    return this.asOf(this.account(account).withdrawals.get(nonce) ?? null);
  }

  async builderFeeApproval(account: UserVenueAccount, builder: string): Promise<AsOf<Amount>> {
    this.up();
    return this.asOf(this.account(account).builderApprovals.get(builder.toLowerCase()) ?? ZERO);
  }

  async agents(account: UserVenueAccount): Promise<AsOf<readonly UserVenueAgent[]>> {
    this.up();
    return this.asOf([...this.account(account).agents.values()]);
  }

  // ── internals ──────────────────────────────────────────────────────────

  private up(): void {
    if (this.switches.venueDown) refuse(this.venue.id, 'venue_down', `${this.venue.displayName} is down (TEST switch)`);
  }

  private asOf<T>(value: T): AsOf<T> {
    return { venueId: this.venue.id, value, asOf: this.clock() };
  }

  private account(account: UserVenueAccount): AccountState {
    const key = accountKey(account);
    let state = this.accounts.get(key);
    if (!state) {
      state = {
        key,
        owner: account.owner.toLowerCase(),
        balances: new Map(),
        orders: new Map(),
        fills: [],
        positions: new Map(),
        withdrawals: new Map(),
        builderApprovals: new Map(),
        agents: new Map(),
        deposits: new Set(),
        leverage: new Map(),
      };
      this.accounts.set(key, state);
    }
    return state;
  }

  private balance(state: AccountState, asset: string): { free: Amount; locked: Amount } {
    let b = state.balances.get(asset);
    if (!b) {
      b = { free: ZERO, locked: ZERO };
      state.balances.set(asset, b);
    }
    return b;
  }

  private market(symbol: string): SimMarketConfig {
    const market = this.marketsBySymbol.get(symbol);
    if (!market) refuse(this.venue.id, 'unknown_market', `${symbol} is not listed on ${this.venue.displayName}`);
    return market;
  }

  private checkOrderOnItsFace(state: AccountState, intent: PlaceUserOrderIntent): void {
    const market = this.market(intent.symbol);
    if (!market.orderTypes.includes(intent.type))
      refuse(this.venue.id, 'not_offered', `${intent.type} orders are not offered on ${market.symbol}`);
    if (intent.type === 'limit' && !market.timeInForce.includes(intent.timeInForce)) {
      refuse(this.venue.id, 'not_offered', `time in force ${intent.timeInForce} is not offered on ${market.symbol}`);
    }
    if (intent.type === 'market' && intent.timeInForce !== 'IOC')
      refuse(this.venue.id, 'venue_rejected', 'a market order is sent as IOC at its worst price');
    if (compare(intent.amount, ZERO) <= 0 || compare(intent.price, ZERO) <= 0)
      refuse(this.venue.id, 'venue_rejected', 'size and price must be positive');
    if (intent.amount % market.lotSize !== ZERO)
      refuse(this.venue.id, 'venue_rejected', `size is not a multiple of the lot size on ${market.symbol}`);
    if (intent.price % market.tickSize !== ZERO)
      refuse(this.venue.id, 'venue_rejected', `price is not a multiple of the tick size on ${market.symbol}`);
    if (market.kind === 'perpetual') {
      if (!state.leverage.has(market.symbol)) {
        refuse(this.venue.id, 'leverage_not_set', `no leverage is set on ${market.symbol} for this account: set it first`);
      }
    } else if (intent.reduceOnly) {
      refuse(this.venue.id, 'not_offered', `${market.symbol} is cash spot: no reduce-only`);
    }
  }

  private checkLeverageOnItsFace(symbol: string, leverageBps: number, marginMode: VenueMarginMode): SimMarketConfig {
    const market = this.market(symbol);
    if (market.kind !== 'perpetual') refuse(this.venue.id, 'not_offered', `${symbol} is cash spot: no leverage or margin mode`);
    if (!market.marginModes.includes(marginMode))
      refuse(this.venue.id, 'not_offered', `margin mode ${marginMode} is not offered on ${symbol}`);
    if (!Number.isInteger(leverageBps) || leverageBps < 10_000 || (market.maxLeverageBps !== null && leverageBps > market.maxLeverageBps)) {
      refuse(this.venue.id, 'not_offered', `leverage ${leverageBps} bps is outside what ${symbol} offers`);
    }
    return market;
  }

  private apply(prepared: PreparedVenueAction): VenueSubmitOutcome {
    const state = this.account(prepared.account);
    const intent = prepared.intent;
    const now = this.clock();
    const refused = (code: VenueRefusalCode, detail: string): VenueSubmitOutcome => ({
      definite: true,
      accepted: false,
      refusal: { venueId: this.venue.id, code, detail },
      asOf: now,
    });
    const accepted = (venueRef: string | null, order: UserVenueOrder | null): VenueSubmitOutcome => ({
      definite: true,
      accepted: true,
      venueRef,
      order,
      asOf: now,
    });

    switch (intent.kind) {
      case 'place_order': {
        const cloid = prepared.venueClientOrderId as string;
        const existing = state.orders.get(cloid);
        if (existing) return accepted(existing.order.venueOrderId, existing.order);
        if (prepared.builderFee) {
          const approved = state.builderApprovals.get(prepared.builderFee.builder) ?? ZERO;
          if (compare(approved, prepared.builderFee.feeBps) < 0)
            return refused('builder_fee_not_approved', 'the builder fee approval no longer covers this order');
        }
        return this.place(state, intent, cloid, prepared.builderFee, refused, accepted);
      }
      case 'cancel_order': {
        const cloid = prepared.venueClientOrderId as string;
        const existing = state.orders.get(cloid);
        if (!existing) return refused('unknown_order', 'no order with that client id');
        if (existing.order.status !== 'open' && existing.order.status !== 'partially_filled') {
          // A repeat cancel reports the same outcome.
          return existing.order.status === 'canceled'
            ? accepted(existing.order.venueOrderId, existing.order)
            : refused('order_final', `the order is already ${existing.order.status}`);
        }
        this.release(existing, 'canceled');
        return accepted(existing.order.venueOrderId, existing.order);
      }
      case 'amend_order': {
        const cloid = prepared.venueClientOrderId as string;
        const existing = state.orders.get(cloid);
        if (!existing) return refused('unknown_order', 'no order with that client id');
        if (existing.order.status !== 'open')
          return refused('order_final', `only an unfilled open order can be amended (it is ${existing.order.status})`);
        return refused('not_offered', 'amend is not offered on the TEST venue simulator: cancel and place a new order');
      }
      case 'withdraw': {
        const fee = this.switches.withdrawalFee.known ? this.switches.withdrawalFee.value : this.switches.unpublishedWithdrawalFee;
        const balance = this.balance(state, intent.asset);
        const needed = add(intent.amount, fee);
        if (compare(balance.free, needed) < 0)
          return refused('insufficient_balance', `free ${intent.asset} does not cover the withdrawal and its fee`);
        balance.free = sub(balance.free, needed);
        const withdrawal: UserVenueWithdrawal = {
          nonce: prepared.nonce,
          asset: intent.asset,
          amount: intent.amount,
          destination: intent.destination.toLowerCase(),
          status: 'pending',
          fee: this.switches.withdrawalFee,
        };
        state.withdrawals.set(prepared.nonce, withdrawal);
        return accepted(prepared.nonce, null);
      }
      case 'update_leverage': {
        const position = state.positions.get(intent.symbol);
        const current = state.leverage.get(intent.symbol);
        if (position && position.size !== ZERO && current && current.marginMode !== intent.marginMode) {
          return refused('venue_rejected', 'the margin mode cannot change while a position is open');
        }
        state.leverage.set(intent.symbol, { leverageBps: intent.leverageBps, marginMode: intent.marginMode });
        return accepted(null, null);
      }
      case 'approve_builder_fee':
        state.builderApprovals.set(intent.builder.toLowerCase(), intent.maxFeeBps);
        return accepted(null, null);
      case 'approve_agent':
        state.agents.set(intent.agentAddress.toLowerCase(), {
          address: intent.agentAddress.toLowerCase(),
          name: intent.agentName,
          validUntil: intent.validUntil,
        });
        return accepted(null, null);
      case 'revoke_agent':
        state.agents.delete(intent.agentAddress.toLowerCase());
        return accepted(null, null);
    }
  }

  private place(
    state: AccountState,
    intent: PlaceUserOrderIntent,
    cloid: string,
    builderFee: PreparedVenueAction['builderFee'],
    refused: (code: VenueRefusalCode, detail: string) => VenueSubmitOutcome,
    accepted: (venueRef: string | null, order: UserVenueOrder | null) => VenueSubmitOutcome,
  ): VenueSubmitOutcome {
    const market = this.market(intent.symbol);
    const perp = market.kind === 'perpetual';
    const crosses = (resting: OrderState) =>
      resting.account !== state &&
      (intent.side === 'buy' ? compare(resting.order.price, intent.price) <= 0 : compare(resting.order.price, intent.price) >= 0);
    const book = this.book.get(market.symbol) as OrderState[];
    const contra = book.filter((o) => o.order.side !== intent.side);
    if (intent.timeInForce === 'ALO' && contra.some(crosses)) return refused('venue_rejected', 'post-only order would take liquidity');

    // What the venue locks for this order.
    const setting = perp ? state.leverage.get(market.symbol) : undefined;
    if (perp && !setting) return refused('leverage_not_set', `no leverage is set on ${market.symbol} for this account`);
    const marginPerUnit = setting ? div(mul(intent.price, BPS), parseAmount(String(setting.leverageBps)), QUOTE_ROUND) : ZERO;
    const position = perp ? state.positions.get(market.symbol) : undefined;
    const closing = perp && position !== undefined && position.size !== ZERO && (position.side === 'long') !== (intent.side === 'buy');
    if (intent.reduceOnly && !closing) return refused('venue_rejected', 'reduce-only order would open or grow a position');
    let lockAsset: string;
    let lockAmount: Amount;
    if (perp) {
      lockAsset = market.quoteAsset;
      lockAmount = closing ? ZERO : mul(marginPerUnit, intent.amount, QUOTE_ROUND);
    } else if (intent.side === 'buy') {
      lockAsset = market.quoteAsset;
      lockAmount = mul(intent.price, intent.amount, QUOTE_ROUND);
    } else {
      lockAsset = market.baseAsset;
      lockAmount = intent.amount;
    }
    const balance = this.balance(state, lockAsset);
    if (compare(balance.free, lockAmount) < 0)
      return refused('insufficient_balance', `free ${lockAsset} does not cover what this order locks`);
    balance.free = sub(balance.free, lockAmount);
    balance.locked = add(balance.locked, lockAmount);

    this.venueOrderCounter += 1;
    this.seqCounter += 1;
    const order: OrderState = {
      account: state,
      seq: this.seqCounter,
      builderFee,
      leverageBps: setting?.leverageBps ?? null,
      marginMode: setting?.marginMode ?? null,
      marginPerUnit,
      order: {
        venueOrderId: `sim-${this.venueOrderCounter}`,
        venueClientOrderId: cloid,
        symbol: market.symbol,
        side: intent.side,
        type: intent.type,
        timeInForce: intent.timeInForce,
        price: intent.price,
        amount: intent.amount,
        filled: ZERO,
        remaining: intent.amount,
        averagePrice: null,
        status: 'open',
        locked: lockAmount,
        lockedAsset: lockAsset,
        reduceOnly: intent.reduceOnly,
      },
    };
    state.orders.set(cloid, order);

    // Match against the contra side, best price first, then time.
    const ordered = contra
      .filter(crosses)
      .sort(
        (a, b) => (intent.side === 'buy' ? compare(a.order.price, b.order.price) : compare(b.order.price, a.order.price)) || a.seq - b.seq,
      );
    for (const maker of ordered) {
      if (order.order.remaining === ZERO) break;
      const qty = min(order.order.remaining, maker.order.remaining);
      this.fill(market, maker, order, qty, maker.order.price);
    }

    if (order.order.remaining !== ZERO) {
      if (intent.type === 'market' || intent.timeInForce === 'IOC') {
        // The unfilled rest of an IOC ends here: final, nothing stays locked.
        this.release(order, 'canceled');
      } else {
        book.push(order);
      }
    }
    return accepted(order.order.venueOrderId, order.order);
  }

  /** One fill between a resting maker and an incoming taker at the maker's price. */
  private fill(market: SimMarketConfig, maker: OrderState, taker: OrderState, qty: Amount, price: Amount): void {
    const now = this.clock();
    for (const [side, role] of [
      [maker, 'maker'],
      [taker, 'taker'],
    ] as const) {
      const notional = mul(price, qty, QUOTE_ROUND);
      const feeBpsKnown = role === 'maker' ? market.makerFeeBps : market.takerFeeBps;
      const feeBps = feeBpsKnown.known ? feeBpsKnown.value : ZERO;
      const venueFee = div(mul(notional, feeBps, QUOTE_ROUND), BPS, QUOTE_ROUND);
      const builderFee = side.builderFee ? div(mul(notional, side.builderFee.feeBps, QUOTE_ROUND), BPS, QUOTE_ROUND) : ZERO;
      const realisedPnl = this.settle(market, side, qty, price, add(venueFee, builderFee));

      const o = side.order; // after settle, which moved its lock
      const filled = add(o.filled, qty);
      const remaining = sub(o.amount, filled);
      const averagePrice = o.averagePrice === null ? price : div(add(mul(o.averagePrice, o.filled), mul(price, qty)), filled);
      side.order = { ...o, filled, remaining, averagePrice, status: remaining === ZERO ? 'filled' : 'partially_filled' };
      if (remaining === ZERO) this.release(side, 'filled');

      this.fillCounter += 1;
      side.account.fills.push({
        fillId: `sim-fill-${this.fillCounter}`,
        venueClientOrderId: o.venueClientOrderId,
        symbol: market.symbol,
        side: o.side,
        price,
        amount: qty,
        role,
        venueFee,
        builderFee,
        feeAsset: market.kind === 'spot' && o.side === 'buy' ? market.baseAsset : market.quoteAsset,
        realisedPnl,
        filledAt: now,
      });
    }
    if (market.kind === 'perpetual') this.marks.set(market.symbol, price);
    const book = this.book.get(market.symbol) as OrderState[];
    this.book.set(
      market.symbol,
      book.filter((o) => o.order.status === 'open' || o.order.status === 'partially_filled'),
    );
  }

  /** Move balances (spot) or the position (perp) for one side of a fill. Returns realised PnL on a perp close. */
  private settle(market: SimMarketConfig, side: OrderState, qty: Amount, price: Amount, fees: Amount): Amount | null {
    const state = side.account;
    const o = side.order;
    if (market.kind === 'spot') {
      const base = this.balance(state, market.baseAsset);
      const quote = this.balance(state, market.quoteAsset);
      const notional = mul(price, qty, QUOTE_ROUND);
      if (o.side === 'buy') {
        const lockedForQty = mul(o.price, qty, QUOTE_ROUND);
        quote.locked = sub(quote.locked, lockedForQty);
        quote.free = add(quote.free, sub(lockedForQty, notional)); // price improvement returns to free
        // The fee is taken from what is received, in base, at the fill price.
        const feeInBase = div(fees, price, QUOTE_ROUND);
        base.free = add(base.free, sub(qty, feeInBase));
      } else {
        base.locked = sub(base.locked, qty);
        quote.free = add(quote.free, sub(notional, fees));
      }
      side.order = { ...side.order, locked: sub(o.locked, o.side === 'buy' ? mul(o.price, qty, QUOTE_ROUND) : qty) };
      return null;
    }

    // Perpetual, isolated margin.
    const usdc = this.balance(state, market.quoteAsset);
    usdc.free = sub(usdc.free, fees);
    const current = state.positions.get(market.symbol);
    const opening = !current || current.size === ZERO || (current.side === 'long') === (o.side === 'buy');
    if (opening) {
      const margin = mul(side.marginPerUnit, qty, QUOTE_ROUND);
      usdc.locked = sub(usdc.locked, margin);
      side.order = { ...side.order, locked: sub(o.locked, margin) };
      if (!current || current.size === ZERO) {
        state.positions.set(market.symbol, {
          side: o.side === 'buy' ? 'long' : 'short',
          size: qty,
          entryPrice: price,
          margin,
          leverageBps: side.leverageBps as number,
          marginMode: side.marginMode as VenueMarginMode,
        });
      } else {
        const size = add(current.size, qty);
        current.entryPrice = div(add(mul(current.entryPrice, current.size), mul(price, qty)), size);
        current.size = size;
        current.margin = add(current.margin, margin);
      }
      return null;
    }
    // Closing (part of) the position.
    const p = current as PositionState;
    const closeQty = min(qty, p.size);
    const pnl = this.pnl(p, price, closeQty);
    const released = closeQty === p.size ? p.margin : div(mul(p.margin, closeQty), p.size);
    p.margin = sub(p.margin, released);
    p.size = sub(p.size, closeQty);
    // The venue's own rules cover a loss beyond margin: the account never goes below zero here.
    usdc.free = max(ZERO, add(usdc.free, add(released, pnl)));
    return pnl;
  }

  private pnl(p: PositionState, price: Amount, qty: Amount): Amount {
    const diff = p.side === 'long' ? sub(price, p.entryPrice) : sub(p.entryPrice, price);
    return mul(diff, qty);
  }

  private liquidationPrice(market: SimMarketConfig, p: PositionState): MaybeKnown<Amount> {
    if (market.maintenanceMarginRate === undefined) return { known: false };
    const maintenance = mul(mul(p.entryPrice, p.size), market.maintenanceMarginRate);
    const cushion = div(sub(p.margin, maintenance), p.size);
    const price = p.side === 'long' ? sub(p.entryPrice, cushion) : add(p.entryPrice, cushion);
    return { known: true, value: max(ZERO, price) };
  }

  /** End an order's remaining lock exactly once. */
  private release(order: OrderState, status: UserVenueOrder['status']): void {
    const o = order.order;
    if (o.locked !== ZERO) {
      const balance = this.balance(order.account, o.lockedAsset);
      balance.locked = sub(balance.locked, o.locked);
      balance.free = add(balance.free, o.locked);
    }
    order.order = { ...order.order, locked: ZERO, status };
    const book = this.book.get(o.symbol) as OrderState[];
    this.book.set(
      o.symbol,
      book.filter((x) => x !== order),
    );
  }
}
