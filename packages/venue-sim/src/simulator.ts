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
  type UserVenueLeverage,
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
import { buildTypedData, digestOf, recoverSigner } from './signing.js';

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
  /** The fee actually charged when `withdrawalFee` is not published (never 0 by default, so "not known" is never read as free). */
  unpublishedWithdrawalFee: Amount;
  /** The trading fees actually charged, and reported on fills, on a market whose fee is not published. */
  unpublishedMakerFeeBps: Amount;
  unpublishedTakerFeeBps: Amount;
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
  /** What the order locks per unit of size: the quote notional (spot buy), 1 (spot sell), or margin plus the most fees (perp). */
  readonly lockPerUnit: Amount;
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
  private lastNonce = 0;
  private readonly withdrawalFeeCharged = new Map<string, Amount>();
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
      unpublishedWithdrawalFee: parseAmount('2'),
      unpublishedMakerFeeBps: parseAmount('2'),
      unpublishedTakerFeeBps: parseAmount('5'),
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
    if (compare(amount, ZERO) <= 0) refuse(this.venue.id, 'venue_rejected', 'a deposit must be positive');
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

  /**
   * Settle every pending withdrawal: `done` (the chain confirmed it) or
   * `failed` (the venue returns the amount and its fee to free).
   */
  settleWithdrawals(outcome: 'done' | 'failed' = 'done'): number {
    let settled = 0;
    for (const state of this.accounts.values()) {
      for (const [nonce, withdrawal] of state.withdrawals) {
        if (withdrawal.status === 'pending') {
          if (outcome === 'failed') {
            const balance = this.balance(state, withdrawal.asset);
            balance.free = add(balance.free, add(withdrawal.amount, this.withdrawalFeeCharged.get(nonce) ?? ZERO));
          }
          state.withdrawals.set(nonce, { ...withdrawal, status: outcome });
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
    if (signer.role === 'agent' && !this.agentLive(state, signer.address)) {
      refuse(this.venue.id, 'signer_not_authorised', `${signer.address.toLowerCase()} is not an approved, unexpired agent on this account`);
    }

    let cloid: string | null = null;
    let builderFee: PreparedVenueAction['builderFee'] = null;
    if (intent.kind === 'place_order') {
      this.checkOrderOnItsFace(state, intent);
      cloid = venueClientOrderId(this.venue.id, intent.clientOrderKey);
      if (intent.builderFee && compare(intent.builderFee.feeBps, ZERO) < 0) {
        refuse(this.venue.id, 'venue_rejected', 'a builder fee cannot be negative');
      }
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
    } else if (intent.kind === 'withdraw' && compare(intent.amount, ZERO) <= 0) {
      refuse(this.venue.id, 'venue_rejected', 'a withdrawal must be positive');
    } else if (intent.kind === 'approve_builder_fee' && compare(intent.maxFeeBps, ZERO) < 0) {
      refuse(this.venue.id, 'venue_rejected', 'a builder fee approval cannot be negative');
    } else if (intent.kind === 'amend_order') {
      refuse(this.venue.id, 'not_offered', 'amend is not offered on the TEST venue simulator: cancel and place a new order');
    } else if (intent.kind === 'withdraw' && account.subAccount !== null) {
      refuse(this.venue.id, 'not_offered', 'a withdrawal from a sub-account is not offered: move the funds to the main account first');
    } else if (intent.kind === 'cancel_order') {
      this.market(intent.symbol);
      cloid = venueClientOrderId(this.venue.id, intent.clientOrderKey);
    }

    // Strictly increasing, and near the clock in microseconds, as a venue's nonce window expects.
    this.lastNonce = Math.max(this.lastNonce + 1, this.clock().getTime() * 1000);
    const nonce = String(this.lastNonce);
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
    const recovered = await recoverSigner(typedData, signature.signature);
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
      // The venue only knows the nonce is used: never a definite refusal (the first action may be the caller's own).
      if (seen.digest !== digest) return { definite: false, reason: 'already_submitted' };
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

  async leverage(account: UserVenueAccount, symbol: string): Promise<AsOf<UserVenueLeverage | null>> {
    this.up();
    this.market(symbol);
    const setting = this.account(account).leverage.get(symbol);
    return this.asOf(setting ? { symbol, ...setting } : null);
  }

  async agents(account: UserVenueAccount): Promise<AsOf<readonly UserVenueAgent[]>> {
    this.up();
    return this.asOf([...this.account(account).agents.values()]);
  }

  // ── internals ──────────────────────────────────────────────────────────

  /** The fee a fill is charged: the published one, or the TEST switch's hidden one when it is not published. */
  private chargedFeeBps(market: SimMarketConfig, role: 'maker' | 'taker'): Amount {
    const published = role === 'maker' ? market.makerFeeBps : market.takerFeeBps;
    if (published.known) return published.value;
    return role === 'maker' ? this.switches.unpublishedMakerFeeBps : this.switches.unpublishedTakerFeeBps;
  }

  private agentLive(state: AccountState, address: string): boolean {
    const agent = state.agents.get(address.toLowerCase());
    return agent !== undefined && (agent.validUntil === null || agent.validUntil.getTime() > this.clock().getTime());
  }

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
      if (intent.reduceOnly && intent.type !== 'market' && intent.timeInForce !== 'IOC') {
        refuse(this.venue.id, 'not_offered', 'a resting reduce-only order is not offered on the TEST simulator: close with IOC or market');
      }
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
    if (
      !Number.isInteger(leverageBps) ||
      leverageBps % 10_000 !== 0 ||
      leverageBps < 10_000 ||
      (market.maxLeverageBps !== null && leverageBps > market.maxLeverageBps)
    ) {
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

    // Authority is checked here, at submit, on the signed fields only: the prepared object is the caller's and may
    // have been edited after prepare. Who signed (recovered from the bytes) must own the account or be its live agent,
    // and an agent never signs an owner-only action.
    try {
      assertSignerMaySign(prepared.account, prepared.signer, intent);
    } catch (error) {
      if (error instanceof VenueRefusalError) return refused(error.refusal.code, error.refusal.detail);
      throw error;
    }
    if (prepared.signer.role === 'agent' && !this.agentLive(state, prepared.signer.address)) {
      return refused('signer_not_authorised', 'the agent key is not approved on this account, or has expired');
    }
    // Every amount must be positive, again here: prepare's checks are not the venue's.
    if (intent.kind === 'withdraw' && compare(intent.amount, ZERO) <= 0) return refused('venue_rejected', 'a withdrawal must be positive');
    if (intent.kind === 'approve_builder_fee' && compare(intent.maxFeeBps, ZERO) < 0) {
      return refused('venue_rejected', 'a builder fee approval cannot be negative');
    }
    // The client order id and the builder fee come from the signed intent, never from the prepared object.
    const cloidOf = (key: string) => venueClientOrderId(this.venue.id, key);

    switch (intent.kind) {
      case 'place_order': {
        const cloid = cloidOf(intent.clientOrderKey);
        const existing = state.orders.get(cloid);
        if (existing) return accepted(existing.order.venueOrderId, existing.order);
        const builderFee = intent.builderFee
          ? { builder: intent.builderFee.builder.toLowerCase(), feeBps: intent.builderFee.feeBps }
          : null;
        if (builderFee) {
          if (compare(builderFee.feeBps, ZERO) < 0) return refused('venue_rejected', 'a builder fee cannot be negative');
          const approved = state.builderApprovals.get(builderFee.builder) ?? ZERO;
          if (compare(approved, builderFee.feeBps) < 0)
            return refused('builder_fee_not_approved', 'the builder fee approval no longer covers this order');
        }
        if (market(this, intent.symbol) === null) return refused('unknown_market', `${intent.symbol} is not listed`);
        return this.place(state, intent, cloid, builderFee, refused, accepted);
      }
      case 'cancel_order': {
        const cloid = cloidOf(intent.clientOrderKey);
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
      case 'amend_order':
        return refused('not_offered', 'amend is not offered on the TEST venue simulator: cancel and place a new order');
      case 'withdraw': {
        const fee = this.switches.withdrawalFee.known ? this.switches.withdrawalFee.value : this.switches.unpublishedWithdrawalFee;
        const balance = this.balance(state, intent.asset);
        const needed = add(intent.amount, fee);
        if (compare(balance.free, needed) < 0)
          return refused('insufficient_balance', `free ${intent.asset} does not cover the withdrawal and its fee`);
        balance.free = sub(balance.free, needed);
        this.withdrawalFeeCharged.set(prepared.nonce, fee);
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
    const crossesPrice = (resting: OrderState) =>
      intent.side === 'buy' ? compare(resting.order.price, intent.price) <= 0 : compare(resting.order.price, intent.price) >= 0;
    const contra = () => this.bookOf(market.symbol).filter((o) => o.order.side !== intent.side);

    // Perpetual rules, checked against the venue's record now.
    const setting = perp ? state.leverage.get(market.symbol) : undefined;
    if (perp && !setting) return refused('leverage_not_set', `no leverage is set on ${market.symbol} for this account`);
    const position = perp ? state.positions.get(market.symbol) : undefined;
    const held = position !== undefined && position.size !== ZERO ? position : undefined;
    if (perp && intent.reduceOnly) {
      if (!held || (held.side === 'long') === (intent.side === 'buy'))
        return refused('venue_rejected', 'reduce-only order would open or grow a position');
      if (compare(intent.amount, held.size) > 0) return refused('venue_rejected', 'reduce-only order is larger than the position');
    } else if (perp) {
      // An order is either opening (grows the position) or reduce-only (closes it). Netting through zero is not simulated.
      if (held && (held.side === 'long') !== (intent.side === 'buy')) {
        return refused(
          'not_offered',
          'closing or flipping a position with an opening order is not offered on the TEST simulator: close it reduce-only',
        );
      }
      const opposite = [...state.orders.values()].some(
        (o) => o.order.symbol === market.symbol && o.order.side !== intent.side && !o.order.reduceOnly && isLive(o),
      );
      if (opposite) return refused('not_offered', 'opening orders on both sides of one market are not offered on the TEST simulator');
    }

    // Post-only is judged against other traders' orders; this account's own crossing orders are cancelled below,
    // only once the new order is sure to be placed, so a refused order never changes the book.
    if (intent.timeInForce === 'ALO' && contra().some((o) => o.account !== state && crossesPrice(o)))
      return refused('venue_rejected', 'post-only order would take liquidity');

    // What the venue locks for this order. A perp order also locks the most it can pay in fees.
    const maxFeeBps = add(this.chargedFeeBps(market, 'taker'), builderFee?.feeBps ?? ZERO);
    const feeBuffer = (notional: Amount) => div(mul(notional, maxFeeBps, QUOTE_ROUND), BPS, QUOTE_ROUND);
    let lockAsset: string;
    let lockPerUnit: Amount;
    if (perp) {
      lockAsset = market.quoteAsset;
      const margin = intent.reduceOnly ? ZERO : div(mul(intent.price, BPS), parseAmount(String(setting!.leverageBps)), QUOTE_ROUND);
      lockPerUnit = add(margin, feeBuffer(intent.price));
    } else if (intent.side === 'buy') {
      lockAsset = market.quoteAsset;
      lockPerUnit = intent.price;
    } else {
      lockAsset = market.baseAsset;
      lockPerUnit = parseAmount('1');
    }
    const lockAmount = mul(lockPerUnit, intent.amount, QUOTE_ROUND);
    const balance = this.balance(state, lockAsset);
    if (compare(balance.free, lockAmount) < 0)
      return refused('insufficient_balance', `free ${lockAsset} does not cover what this order locks`);
    // Self-trade prevention: this account's own resting orders that the new order would cross are cancelled now.
    for (const own of contra().filter((o) => o.account === state && crossesPrice(o))) this.release(own, 'canceled');
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
      lockPerUnit,
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
    const ordered = contra()
      .filter(crossesPrice)
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
        this.bookOf(market.symbol).push(order);
      }
    }
    return accepted(order.order.venueOrderId, order.order);
  }

  private bookOf(symbol: string): OrderState[] {
    return this.book.get(symbol) as OrderState[];
  }

  /** One fill between a resting maker and an incoming taker at the maker's price. */
  private fill(market: SimMarketConfig, maker: OrderState, taker: OrderState, qty: Amount, price: Amount): void {
    const now = this.clock();
    for (const [side, role] of [
      [maker, 'maker'],
      [taker, 'taker'],
    ] as const) {
      const feeBps = this.chargedFeeBps(market, role);
      // A spot buy pays its fees in the base it receives; everything else pays in the quote asset.
      const feeInBase = market.kind === 'spot' && side.order.side === 'buy';
      const feeBasis = feeInBase ? qty : mul(price, qty, QUOTE_ROUND);
      const venueFeeDue = div(mul(feeBasis, feeBps, QUOTE_ROUND), BPS, QUOTE_ROUND);
      let builderFee = side.builderFee ? div(mul(feeBasis, side.builderFee.feeBps, QUOTE_ROUND), BPS, QUOTE_ROUND) : ZERO;
      let venueFee = venueFeeDue;
      const { realisedPnl, uncharged } = this.settle(market, side, qty, price, add(venueFee, builderFee));
      // Report only what was charged: a fee the account could not pay is cut from our builder fee first.
      const builderCut = min(builderFee, uncharged);
      builderFee = sub(builderFee, builderCut);
      venueFee = sub(venueFee, sub(uncharged, builderCut));

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
        feeAsset: feeInBase ? market.baseAsset : market.quoteAsset,
        realisedPnl,
        filledAt: now,
      });
    }
    if (market.kind === 'perpetual') this.marks.set(market.symbol, price);
  }

  /**
   * Move balances (spot) or the position (perp) for one side of a fill, and
   * take this fill's share out of the order's lock exactly once. Returns the
   * realised result on a perp close.
   */
  private settle(
    market: SimMarketConfig,
    side: OrderState,
    qty: Amount,
    price: Amount,
    fees: Amount,
  ): { realisedPnl: Amount | null; uncharged: Amount } {
    const state = side.account;
    const o = side.order;
    const lockForQty = min(o.locked, mul(side.lockPerUnit, qty, QUOTE_ROUND));
    const lockBalance = this.balance(state, o.lockedAsset);
    lockBalance.locked = sub(lockBalance.locked, lockForQty);
    side.order = { ...o, locked: sub(o.locked, lockForQty) };

    if (market.kind === 'spot') {
      const base = this.balance(state, market.baseAsset);
      const quote = this.balance(state, market.quoteAsset);
      const notional = mul(price, qty, QUOTE_ROUND);
      if (o.side === 'buy') {
        quote.free = add(quote.free, sub(lockForQty, notional)); // price improvement returns to free
        base.free = add(base.free, sub(qty, fees));
      } else {
        quote.free = add(quote.free, sub(notional, fees));
      }
      return { realisedPnl: null, uncharged: ZERO };
    }

    // Perpetual, isolated margin. The order's lock pays this fill's margin and fees; the rest returns to free.
    const usdc = this.balance(state, market.quoteAsset);
    const current = state.positions.get(market.symbol);
    if (!o.reduceOnly) {
      const margin = div(mul(mul(price, qty, QUOTE_ROUND), BPS), parseAmount(String(side.leverageBps)), QUOTE_ROUND);
      // A short that fills above its limit needs a little more margin than it locked: from free, while free has it.
      const needed = add(margin, fees);
      const extra = compare(needed, lockForQty) > 0 ? min(sub(needed, lockForQty), usdc.free) : ZERO;
      usdc.free = sub(usdc.free, extra);
      const available = add(lockForQty, extra);
      const posted = max(ZERO, min(margin, sub(available, fees)));
      usdc.free = add(usdc.free, sub(available, add(posted, fees)));
      // Posted margin is "used as margin": it stays in locked until the position closes (user-venue.ts).
      usdc.locked = add(usdc.locked, posted);
      if (!current || current.size === ZERO) {
        state.positions.set(market.symbol, {
          side: o.side === 'buy' ? 'long' : 'short',
          size: qty,
          entryPrice: price,
          margin: posted,
          leverageBps: side.leverageBps as number,
          marginMode: side.marginMode as VenueMarginMode,
        });
      } else {
        if ((current.side === 'long') !== (o.side === 'buy'))
          throw new Error('TEST simulator invariant: an opening fill met an opposite position');
        const size = add(current.size, qty);
        current.entryPrice = div(add(mul(current.entryPrice, current.size), mul(price, qty)), size, QUOTE_ROUND);
        current.size = size;
        current.margin = add(current.margin, posted);
      }
      return { realisedPnl: null, uncharged: ZERO };
    }
    // Reduce-only: close (part of) the position. Isolated: the loss stops at the margin released.
    const p = current as PositionState;
    const closeQty = min(qty, p.size);
    const pnl = this.pnl(p, price, closeQty);
    const released = closeQty === p.size ? p.margin : div(mul(p.margin, closeQty), p.size, QUOTE_ROUND);
    p.margin = sub(p.margin, released);
    p.size = sub(p.size, closeQty);
    usdc.locked = sub(usdc.locked, released);
    const realised = max(pnl, sub(ZERO, released));
    const feeFromLock = min(fees, lockForQty);
    const feeLeft = sub(fees, feeFromLock);
    const back = add(released, realised);
    const feeFromBack = min(feeLeft, back);
    usdc.free = add(usdc.free, add(sub(lockForQty, feeFromLock), sub(back, feeFromBack)));
    return { realisedPnl: realised, uncharged: sub(feeLeft, feeFromBack) };
  }

  private pnl(p: PositionState, price: Amount, qty: Amount): Amount {
    const diff = p.side === 'long' ? sub(price, p.entryPrice) : sub(p.entryPrice, price);
    return mul(diff, qty);
  }

  /**
   * The simulator's own liquidation price: where the margin left after the
   * maintenance requirement (taken at entry notional) is used up. A simple
   * isolated-margin formula, not any real venue's; a real venue's adapter
   * reports the venue's figure.
   */
  private liquidationPrice(market: SimMarketConfig, p: PositionState): MaybeKnown<Amount> {
    if (market.maintenanceMarginRate === undefined) return { known: false };
    const maintenance = mul(mul(p.entryPrice, p.size), market.maintenanceMarginRate);
    const cushion = div(sub(p.margin, maintenance), p.size, 'floor');
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
    const book = this.bookOf(o.symbol);
    const at = book.indexOf(order);
    if (at >= 0) book.splice(at, 1);
  }
}

function isLive(o: OrderState): boolean {
  return o.order.status === 'open' || o.order.status === 'partially_filled';
}

function market(sim: TestVenueSimulator, symbol: string): SimMarketConfig | null {
  return (sim as unknown as { marketsBySymbol: Map<string, SimMarketConfig> }).marketsBySymbol.get(symbol) ?? null;
}
