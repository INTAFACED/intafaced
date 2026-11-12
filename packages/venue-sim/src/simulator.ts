import { createHash } from 'node:crypto';
import { add, compare, div, formatAmount, max, min, mul, parseAmount, sub, ZERO, type Amount } from '@intafaced/ledger-client/money';
import {
  VenueRefusalError,
  assertSignatureMatches,
  assertSignerMaySign,
  venueClientOrderId,
  type AsOf,
  type MaybeKnown,
  type VenueBuilderTotals,
  type PlaceUserOrderIntent,
  type PreparedVenueAction,
  type UserVenue,
  type UserVenueAccount,
  type UserVenueAgent,
  type UserVenueBalance,
  type UserVenueDeposit,
  type UserVenueDescriptor,
  type UserVenueFeed,
  type UserVenueFunding,
  type UserVenueFill,
  type UserVenueLeverage,
  type UserVenueListing,
  type UserVenueMarket,
  type UserVenueMarketStatus,
  type UserVenueOrder,
  type UserVenuePosition,
  type UserVenueSubAccount,
  type UserVenueSession,
  type UserVenueSubAccountReads,
  type UserVenueTransfer,
  type UserVenueWithdrawal,
  type VenueAssetAmount,
  type VenueIntent,
  type VenueBook,
  type VenueBookLevel,
  type VenueOrderPreview,
  type VenueBestPrices,
  type VenueMarginMode,
  type VenueRefusalCode,
  type VenueSignature,
  type VenueSigner,
  type VenueSubmitOutcome,
} from '@intafaced/venue-contracts';
import { TEST_VENUE_CHAIN_ID, buildTypedData, digestOf, recoverSigner, testVenueDomain } from './signing.js';

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
 *   · `unlistPerpetuals` — the market list leaves out every perpetual, as a
 *     venue that lists no contract for this account; nothing else changes;
 *   · a market's `orderTypes` / `timeInForce` / `marginModes` — anything not
 *     listed refuses `not_offered` at prepare, before the wallet is asked;
 *   · `makerFeeBps` / `takerFeeBps` `known: false` — the fee is not published;
 *   · `withdrawalFee` `known: false` — the withdrawal fee is shown as not known;
 *   · `networkFee` `known: false` — the withdrawal's network fee is shown as
 *     not known (what arrives is still the amount less the fee charged);
 *   · an agent key is always refused a withdrawal (`agent_not_permitted`);
 *   · `loseAnswers` — the next N submits are applied and then answered
 *     `definite: false`, so a caller's read-back is exercised;
 *   · a market's own state (`setMarketStatus`: trading, halted, cancel_only,
 *     delisted, or `null` for "not reported") and its largest order
 *     (`setMarketLimits`, `null` for "not reported"). A new order its state does
 *     not admit refuses `market_halted` / `market_cancel_only` /
 *     `market_delisted`, one above its largest `order_above_venue_max`; cancels
 *     always pass.
 *   · `setFeed(symbol, 'stale')` — a market priced by an oracle (`oracle`)
 *     reports its feed stale and follows its own published stale rule: the
 *     mark holds at the last oracle price and only reduce-only orders are
 *     taken (an opening order refuses `feed_stale` with the rule's words).
 *
 *   · `setSession(symbol, 'off_hours')` — a market with a home market
 *     (`session`, a stock perpetual) reports it closed and follows its own
 *     published off-hours rule: an opening market order, an opening order
 *     above the off-hours leverage cap, and an opening limit outside the
 *     off-hours band around the last open-hours mark each refuse
 *     `market_off_hours` with the rule's words; reduce-only closes pass.
 *
 * A leverage above a market's cap refuses `leverage_above_cap`, its detail
 * naming the cap (`XAU-PERP allows at most 10x`), at prepare and at submit.
 *
 * Sub-accounts and agents, as a real venue keeps them (Hyperliquid's rules,
 * read 2026-11-09): the owner opens a sub-account and moves free balance in
 * and out of it, both signed on the main account; a sub-account has no key,
 * so it is never withdrawn from. An agent is approved per account (main or
 * sub) and trades that account only. At most `MAX_NAMED_AGENTS_MAIN` named
 * agents on a main account and `MAX_NAMED_AGENTS_SUB` on a sub-account (one
 * unnamed agent besides); approving a new key under a name already in use
 * replaces the old key. An expiry is at most `MAX_AGENT_VALIDITY_MS` ahead.
 * An agent address once revoked or replaced on an account is never approved
 * there again (a venue that prunes old nonces could accept a replay of its
 * old signed actions).
 */

export const MAX_NAMED_AGENTS_MAIN = 3;
export const MAX_NAMED_AGENTS_SUB = 2;
export const MAX_AGENT_VALIDITY_MS = 180 * 24 * 60 * 60 * 1000;

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
  /**
   * The venue's own published cap on a builder fee on this market (scaled bps). Absent: the venue publishes none, it
   * reads `known: false` and the simulator enforces no cap.
   */
  readonly builderFeeCapBps?: MaybeKnown<Amount>;
  /** Perpetuals: maintenance margin as a fraction of notional (scaled decimal, `parseAmount('0.005')`). */
  readonly maintenanceMarginRate?: Amount;
  /** Perpetuals: the starting mark price (on a market with an `oracle`, its starting oracle price). */
  readonly markPrice?: Amount;
  /** Base units per contract, as the venue publishes it. Unset: not published. */
  readonly contractSize?: Amount;
  /**
   * Perpetuals: the funding the venue publishes, a signed scaled fraction of notional per `intervalSeconds`, the next
   * settlement at the next whole interval on the venue's clock. Unset: not published. TEST: the simulator publishes
   * the rate and settles no funding, so no TEST position is ever charged or paid it.
   */
  readonly funding?: { readonly rate: Amount; readonly intervalSeconds: number };
  /** The market's own state at start; absent is `trading`. */
  readonly status?: UserVenueMarketStatus | null;
  /** The largest order size (base) and notional (quote) at start; absent is `null` (not reported). TEST figures. */
  readonly maxOrderQty?: Amount | null;
  readonly maxOrderNotional?: Amount | null;
  /** Who lists the market, as the venue publishes it. Unset: not published. */
  readonly listedBy?: UserVenueListing;
  /** The venue's published oracle and mark-price rules and trading hours, in its words. Unset: not published. */
  readonly oracleRule?: string;
  readonly markRule?: string;
  readonly tradingHours?: string;
  /**
   * Set on a perpetual priced by an oracle: its mark is the oracle price (a fill does not move it), its feed state is
   * published, and while the feed is stale the mark holds and only reduce-only orders are taken. `staleRule` is the
   * venue's published words for that rule (unset: not published, though the venue still follows it).
   */
  readonly oracle?: { readonly staleRule?: string };
  /**
   * Set on a market that tracks something traded on a home market with its own hours (a stock perpetual): its session
   * is published, `open` at start. While `off_hours` (`setSession`) the venue follows its own rule: no opening market
   * order, no opening order above `offHoursMaxLeverageBps`, and no opening limit priced outside `offHoursBandBps` of the
   * mark when the home market closed. The words are the venue's (unset: not published, though the venue still follows
   * the rule); `reopensAfterMs` sets the reopen time it publishes when it closes (unset: none published).
   */
  readonly session?: {
    readonly homeMarket: string;
    readonly offHoursMode?: string;
    readonly offHoursBand?: string;
    readonly offHoursBandBps: number;
    readonly offHoursMaxLeverageBps: number;
    readonly offHoursRule?: string;
    readonly reopensAfterMs?: number;
  };
}

/**
 * TEST: how old the TEST venue says its figures may be before they are stale (b2 change 6). A real venue's adapter
 * declares its own; this TEST value stands in on test stacks only.
 */
export const TEST_VENUE_FIGURE_STALE_AFTER_MS = 60_000;

export interface SimSwitches {
  venueDown: boolean;
  /** The venue's builder totals read as not known (OWNER 288 1e), as on a venue that publishes none. */
  builderTotalsUnknown: boolean;
  /** The market list leaves out every perpetual (a venue that lists no contract here); orders are not affected. */
  unlistPerpetuals: boolean;
  withdrawalFee: MaybeKnown<Amount>;
  /** The fee actually charged when `withdrawalFee` is not published (never 0 by default, so "not known" is never read as free). */
  unpublishedWithdrawalFee: Amount;
  /** The network fee a withdrawal reports, taken from what arrives at its destination. */
  networkFee: MaybeKnown<Amount>;
  /**
   * The explorer link the venue gives each chain deposit, a transaction hash appended (J-dex-protocol-05 #2); `null` for a
   * network with no explorer, when a deposit shows its hash alone.
   */
  depositExplorerTxUrl: string | null;
  /** The network fee actually taken when `networkFee` is not published (never 0 by default, as `unpublishedWithdrawalFee`). */
  unpublishedNetworkFee: Amount;
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
  /** The EIP-712 domain's chain id (signing.ts). Default `TEST_VENUE_CHAIN_ID`. */
  readonly chainId?: number;
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
  /** Main account only: its sub-accounts, by venue id. */
  readonly subAccounts: Map<string, UserVenueSubAccount>;
  /** Main account only: moves to and from its sub-accounts, by signed nonce. */
  readonly transfers: Map<string, UserVenueTransfer>;
  /** Agent addresses revoked or replaced on this account: never approved here again. */
  readonly retiredAgents: Set<string>;
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

export class TestVenueSimulator implements UserVenue, UserVenueSubAccountReads {
  readonly venue: UserVenueDescriptor;
  readonly switches: SimSwitches;
  /** The chain id every action's EIP-712 domain names. */
  readonly chainId: number;
  private readonly clock: () => Date;
  private readonly marketsBySymbol = new Map<string, SimMarketConfig>();
  private readonly marks = new Map<string, Amount>();
  /** Oracle markets: the time the feed went stale, or absent while it is live (a live oracle updates as the clock runs). */
  private readonly staleSince = new Map<string, Date>();
  /** Session markets whose off-hours words the venue publishes none of (`setSessionPublished`); it still follows its rule. */
  private readonly sessionUnpublished = new Set<string>();
  /** Session markets whose home market is closed: the mark when it closed, and the reopen time the venue published. */
  private readonly offHours = new Map<string, { closedMark: Amount; reopensAt: Date | null }>();
  private readonly accounts = new Map<string, AccountState>();
  private readonly submitted = new Map<string, Map<string, SubmittedRecord>>(); // account → nonce → record
  /** TEST: per account, how many more submits lose their answer (`loseAnswersOn`). */
  private readonly lostAnswers = new Map<string, number>();
  private readonly resting = new Map<string, OrderState[]>(); // symbol → resting orders
  private lastNonce = 0;
  private readonly withdrawalFeeCharged = new Map<string, Amount>();
  private readonly networkFeeCharged = new Map<string, Amount>();
  private readonly withdrawalSubmittedAt = new Map<string, Date>();
  /** Every on-chain deposit the venue has seen, by its transfer id, with the main account it is for (J-dex-protocol-05 #2). */
  private readonly chainDeposits = new Map<string, { readonly accountKey: string; record: UserVenueDeposit }>();
  private seqCounter = 0;
  private fillCounter = 0;
  /** Builder fees charged, by builder address and fee asset: the venue's own builder totals (OWNER 288 1e). */
  private readonly builderEarned = new Map<string, Map<string, Amount>>();
  private venueOrderCounter = 0;
  /** Each market's own state and largest order, changed by the TEST controls. */
  private readonly marketState = new Map<
    string,
    { status: UserVenueMarketStatus | null; maxOrderQty: Amount | null; maxOrderNotional: Amount | null }
  >();

  constructor(options: SimOptions) {
    const id = options.id ?? 'test-venue-sim';
    this.venue = {
      id,
      displayName: options.displayName ?? 'TEST venue simulator',
      kind: 'external-dex',
      sequencedDepth: true,
      proofLevel: 'simulator',
      figureStaleAfterMs: TEST_VENUE_FIGURE_STALE_AFTER_MS,
    };
    this.clock = options.clock;
    this.chainId = testVenueDomain(options.chainId ?? TEST_VENUE_CHAIN_ID).chainId;
    this.switches = {
      venueDown: false,
      builderTotalsUnknown: false,
      unlistPerpetuals: false,
      withdrawalFee: { known: true, value: parseAmount('1') },
      unpublishedWithdrawalFee: parseAmount('2'),
      networkFee: { known: true, value: parseAmount('0.25') },
      depositExplorerTxUrl: null,
      unpublishedNetworkFee: parseAmount('0.5'),
      unpublishedMakerFeeBps: parseAmount('2'),
      unpublishedTakerFeeBps: parseAmount('5'),
      loseAnswers: 0,
      ...options.switches,
    };
    for (const market of options.markets) {
      this.marketsBySymbol.set(market.symbol, market);
      this.resting.set(market.symbol, []);
      if (market.markPrice !== undefined) this.marks.set(market.symbol, market.markPrice);
      this.marketState.set(market.symbol, {
        status: market.status === undefined ? 'trading' : market.status,
        maxOrderQty: market.maxOrderQty ?? null,
        maxOrderNotional: market.maxOrderNotional ?? null,
      });
    }
  }

  /**
   * TEST control: list one more market on the venue, so a journey can review a market nobody else trades. Refused when the
   * symbol is already listed (a market's config is never replaced under its orders). Starts `trading` unless told.
   */
  addMarket(market: SimMarketConfig): void {
    if (this.marketsBySymbol.has(market.symbol)) {
      refuse(this.venue.id, 'not_offered', `${market.symbol} is already listed on ${this.venue.displayName}`);
    }
    this.marketsBySymbol.set(market.symbol, market);
    this.resting.set(market.symbol, []);
    if (market.markPrice !== undefined) this.marks.set(market.symbol, market.markPrice);
    this.marketState.set(market.symbol, {
      status: market.status === undefined ? 'trading' : market.status,
      maxOrderQty: market.maxOrderQty ?? null,
      maxOrderNotional: market.maxOrderNotional ?? null,
    });
  }

  /** TEST control: the market's own state (`null`: the venue reports none). Changes no order. */
  setMarketStatus(symbol: string, status: UserVenueMarketStatus | null): void {
    this.market(symbol);
    this.marketState.get(symbol)!.status = status;
  }

  /** TEST control: the trading fees this market publishes; `known: false` publishes none (the venue still charges its unpublished rate). */
  setMarketFees(symbol: string, fees: { makerFeeBps: MaybeKnown<Amount>; takerFeeBps: MaybeKnown<Amount> }): void {
    const market = this.market(symbol);
    this.marketsBySymbol.set(symbol, { ...market, makerFeeBps: fees.makerFeeBps, takerFeeBps: fees.takerFeeBps });
  }

  /**
   * TEST control: the most leverage the venue now allows on a perpetual (bps; a deployer raising or lowering its cap).
   * A held leverage setting stays as it was; an opening order at a setting above the new cap refuses `leverage_above_cap`.
   */
  setMarketMaxLeverage(symbol: string, maxLeverageBps: number): void {
    const market = this.market(symbol);
    if (market.kind !== 'perpetual') refuse(this.venue.id, 'not_offered', `${symbol} is cash spot: no leverage`);
    if (!Number.isInteger(maxLeverageBps) || maxLeverageBps < 10_000 || maxLeverageBps % 10_000 !== 0)
      refuse(this.venue.id, 'venue_rejected', `a leverage cap is a whole number of times, 1x or more (got ${maxLeverageBps} bps)`);
    this.marketsBySymbol.set(symbol, { ...market, maxLeverageBps });
  }

  /** TEST control: the market's largest order size and notional (`null`: not reported). Changes no order. */
  setMarketLimits(symbol: string, limits: { maxOrderQty: Amount | null; maxOrderNotional: Amount | null }): void {
    this.market(symbol);
    const state = this.marketState.get(symbol)!;
    state.maxOrderQty = limits.maxOrderQty;
    state.maxOrderNotional = limits.maxOrderNotional;
  }

  // ── test controls (the simulator's own levers; never part of UserVenue) ──

  /**
   * TEST control: every account's fills since a time, each with the account it belongs to, so a TEST journey can
   * account for every fill on the venue in a period (never part of UserVenue; a real venue reports only your own).
   */
  testAllFills(since: Date): AsOf<readonly { owner: string; subAccount: string | null; fill: UserVenueFill }[]> {
    const out: { owner: string; subAccount: string | null; fill: UserVenueFill }[] = [];
    for (const a of this.accounts.values()) {
      const sub = a.key.slice(a.key.indexOf('/') + 1);
      for (const fill of a.fills)
        if (fill.filledAt.getTime() >= since.getTime()) out.push({ owner: a.owner, subAccount: sub === '' ? null : sub, fill });
    }
    out.sort((x, y) => x.fill.filledAt.getTime() - y.fill.filledAt.getTime());
    return this.asOf(out);
  }

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

  /**
   * Record what the venue has seen of one on-chain deposit (chain-deposits.ts): confirming, credited, or not credited.
   * The first sighting's time is kept; a later call only moves its confirmations and status on. A credited deposit never
   * goes back to confirming. Nothing here credits: `deposit` does, by the same transfer id.
   */
  trackChainDeposit(
    account: UserVenueAccount,
    seen: Omit<UserVenueDeposit, 'seenAt' | 'status' | 'explorerUrl'> & { readonly status: UserVenueDeposit['status'] },
  ): void {
    const state = this.account(account);
    const before = this.chainDeposits.get(seen.depositRef);
    const credited = state.deposits.has(seen.depositRef);
    const status: UserVenueDeposit['status'] = credited ? 'credited' : before?.record.status === 'credited' ? 'credited' : seen.status;
    this.chainDeposits.set(seen.depositRef, {
      accountKey: state.key,
      record: {
        ...seen,
        status,
        confirmations: Math.max(seen.confirmations, before?.record.confirmations ?? 0),
        seenAt: before?.record.seenAt ?? this.clock(),
        explorerUrl: null,
      },
    });
  }

  /** The on-chain deposits the venue has seen for this account, newest first (J-dex-protocol-05 #2). */
  async deposits(account: UserVenueAccount): Promise<AsOf<readonly UserVenueDeposit[]>> {
    this.up();
    const key = this.account(account).key;
    // The explorer link as the venue gives it now: its network's explorer, or none.
    const explorer = this.switches.depositExplorerTxUrl;
    const mine = [...this.chainDeposits.values()]
      .filter((d) => d.accountKey === key)
      .map((d) => ({ ...d.record, explorerUrl: explorer ? `${explorer}${d.record.txHash}` : null }));
    return this.asOf(mine.reverse());
  }

  /**
   * Move a perpetual's mark price. On a market priced by an oracle this is an oracle update, which a stale feed does not
   * make: it refuses `feed_stale` and the mark holds. While a session market's home market is closed it refuses
   * `market_off_hours`: the mark holds at the last open-hours price.
   */
  setMark(symbol: string, price: Amount): void {
    if (this.staleSince.has(symbol))
      refuse(this.venue.id, 'feed_stale', `${symbol}'s oracle is stale: its price is not updating, so the mark holds`);
    if (this.offHours.has(symbol))
      refuse(this.venue.id, 'market_off_hours', `${symbol}'s home market is closed: the mark holds at the last open-hours price`);
    this.marks.set(symbol, price);
  }

  /** TEST: the next `count` submits on this account are applied and then answered `definite: false` (a lost answer). */
  loseAnswersOn(account: UserVenueAccount, count: number): void {
    if (!Number.isSafeInteger(count) || count < 0) throw new Error('count must be a whole number, zero or more');
    this.lostAnswers.set(accountKey(account), count);
  }

  /**
   * TEST: the expiry of this account's agent passes now, as it would when its time came: the venue's record keeps the
   * agent with its expiry set to now, so it signs nothing more. Returns false when the account has no such agent.
   */
  expireAgent(account: UserVenueAccount, agentAddress: string): boolean {
    const state = this.account(account);
    const agent = state.agents.get(agentAddress.toLowerCase());
    if (!agent) return false;
    state.agents.set(agent.address, { ...agent, validUntil: this.clock() });
    return true;
  }

  /**
   * Make an oracle market's feed stale (the oracle stops updating at this moment) or live again. A market with no
   * oracle has no feed to switch: refuses `not_offered`.
   */
  setFeed(symbol: string, state: 'live' | 'stale'): void {
    const market = this.market(symbol);
    if (!market.oracle) refuse(this.venue.id, 'not_offered', `${symbol} is not priced by an oracle on ${this.venue.displayName}`);
    if (state === 'live') this.staleSince.delete(symbol);
    else if (!this.staleSince.has(symbol)) this.staleSince.set(symbol, this.clock());
  }

  /**
   * Close a session market's home market (`off_hours`: the venue's off-hours rule applies from now, the band around the
   * mark at this moment) or open it again. A market with no home market has no session to switch: refuses `not_offered`.
   */
  setSession(symbol: string, state: 'open' | 'off_hours'): void {
    const market = this.market(symbol);
    if (!market.session) refuse(this.venue.id, 'not_offered', `${symbol} has no home market on ${this.venue.displayName}`);
    if (state === 'open') {
      this.offHours.delete(symbol);
      return;
    }
    if (this.offHours.has(symbol)) return;
    const closedMark = this.marks.get(symbol);
    if (closedMark === undefined) throw new Error(`TEST simulator: ${symbol} has no mark to hold its off-hours band to`);
    const after = market.session.reopensAfterMs;
    this.offHours.set(symbol, {
      closedMark,
      reopensAt: after === undefined ? null : new Date(this.clock().getTime() + after),
    });
  }

  /**
   * TEST control: whether the venue publishes a session market's off-hours words (its mode, band, leverage, reopen time
   * and rule). Unpublished, each reads not published while the venue still follows the same rule.
   */
  setSessionPublished(symbol: string, published: boolean): void {
    const market = this.market(symbol);
    if (!market.session) refuse(this.venue.id, 'not_offered', `${symbol} has no home market on ${this.venue.displayName}`);
    if (published) this.sessionUnpublished.delete(symbol);
    else this.sessionUnpublished.add(symbol);
  }

  /**
   * Settle every pending withdrawal: `done` (the chain confirmed it) or
   * `failed` (the venue returns the amount and its fee to free).
   */
  settleWithdrawals(outcome: 'done' | 'failed' = 'done'): number {
    let settled = 0;
    for (const pending of this.pendingWithdrawals()) {
      if (this.settleWithdrawal(pending.account, pending.nonce, outcome)) settled += 1;
    }
    return settled;
  }

  /**
   * Every pending withdrawal, oldest first, with what is to arrive at its destination: the amount less the network fee
   * taken (published or not). What a chain sender pays out before it settles one `done` (chain-deposits.ts).
   */
  pendingWithdrawals(): Array<{
    readonly account: UserVenueAccount;
    readonly nonce: string;
    readonly withdrawal: UserVenueWithdrawal;
    readonly arrives: Amount;
    readonly submittedAt: Date;
  }> {
    const out: ReturnType<TestVenueSimulator['pendingWithdrawals']> = [];
    for (const state of this.accounts.values()) {
      for (const [nonce, withdrawal] of state.withdrawals) {
        if (withdrawal.status !== 'pending') continue;
        const taken = this.networkFeeCharged.get(`${state.key}#${nonce}`) ?? ZERO;
        const arrives = compare(withdrawal.amount, taken) > 0 ? sub(withdrawal.amount, taken) : ZERO;
        const subAccount = state.key.slice(state.key.indexOf('/') + 1);
        out.push({
          account: { venueId: this.venue.id, owner: state.owner, subAccount: subAccount === '' ? null : subAccount },
          nonce,
          withdrawal,
          arrives,
          submittedAt: this.withdrawalSubmittedAt.get(`${state.key}#${nonce}`) ?? new Date(0),
        });
      }
    }
    return out.sort((a, b) => a.submittedAt.getTime() - b.submittedAt.getTime());
  }

  /**
   * Settle one pending withdrawal: `done` (the chain confirmed it) or `failed` (the venue returns the amount and its fee
   * to free). False when it is not pending (already settled, or unknown): settling twice changes nothing.
   */
  settleWithdrawal(account: UserVenueAccount, nonce: string, outcome: 'done' | 'failed'): boolean {
    const state = this.account(account);
    const withdrawal = state.withdrawals.get(nonce);
    if (!withdrawal || withdrawal.status !== 'pending') return false;
    if (outcome === 'failed') {
      const balance = this.balance(state, withdrawal.asset);
      balance.free = add(balance.free, add(withdrawal.amount, this.withdrawalFeeCharged.get(`${state.key}#${nonce}`) ?? ZERO));
    }
    state.withdrawals.set(nonce, { ...withdrawal, status: outcome });
    return true;
  }

  // ── UserVenue: market reads ────────────────────────────────────────────

  async markets(_account: UserVenueAccount | null): Promise<AsOf<readonly UserVenueMarket[]>> {
    this.up();
    const listed = [...this.marketsBySymbol.values()].filter((m) => !(this.switches.unlistPerpetuals && m.kind === 'perpetual'));
    const list: UserVenueMarket[] = listed.map((m) => ({
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
      status: this.marketState.get(m.symbol)!.status,
      maxOrderQty: this.marketState.get(m.symbol)!.maxOrderQty,
      maxOrderNotional: this.marketState.get(m.symbol)!.maxOrderNotional,
      builderFeeCapBps: m.builderFeeCapBps ?? { known: false },
      listedBy: published(m.listedBy),
      oracleRule: published(m.oracleRule),
      markRule: published(m.markRule),
      tradingHours: published(m.tradingHours),
      feed: m.oracle ? { known: true, value: this.feedOf(m) } : { known: false },
      session: m.session ? { known: true, value: this.sessionOf(m) } : { known: false },
      contractSize: published(m.contractSize),
      mark: published(m.kind === 'perpetual' ? this.marks.get(m.symbol) : undefined),
      funding: m.funding ? { known: true, value: this.fundingOf(m.funding) } : { known: false },
    }));
    return this.asOf(list);
  }

  /** The best resting bid and ask on `symbol`, every account's orders, as the public book shows them. */
  async bestPrices(symbol: string): Promise<AsOf<VenueBestPrices>> {
    this.up();
    const market = this.market(symbol);
    let bid: Amount | null = null;
    let ask: Amount | null = null;
    for (const o of this.bookOf(market.symbol)) {
      if (o.order.side === 'buy' && (bid === null || compare(o.order.price, bid) > 0)) bid = o.order.price;
      if (o.order.side === 'sell' && (ask === null || compare(o.order.price, ask) < 0)) ask = o.order.price;
    }
    return this.asOf({ symbol: market.symbol, bid, ask });
  }

  async book(symbol: string, depth: number): Promise<AsOf<VenueBook>> {
    this.up();
    this.market(symbol);
    const levels = (side: 'buy' | 'sell'): VenueBookLevel[] => {
      const out: VenueBookLevel[] = [];
      const resting = this.bookOf(symbol)
        .filter((o) => o.order.side === side && o.order.remaining > ZERO)
        .sort((a, b) => (side === 'buy' ? compare(b.order.price, a.order.price) : compare(a.order.price, b.order.price)));
      for (const o of resting) {
        const last = out[out.length - 1];
        if (last && compare(last.price, o.order.price) === 0)
          out[out.length - 1] = { price: last.price, amount: add(last.amount, o.order.remaining) };
        else if (out.length < depth) out.push({ price: o.order.price, amount: o.order.remaining });
        else break;
      }
      return out;
    };
    return this.asOf({ symbol, bids: levels('buy'), asks: levels('sell') });
  }

  async preview(account: UserVenueAccount, intent: PlaceUserOrderIntent): Promise<AsOf<VenueOrderPreview>> {
    this.up();
    if (account.venueId !== this.venue.id)
      refuse(this.venue.id, 'venue_rejected', `account is on ${account.venueId}, not ${this.venue.id}`);
    const state = this.account(account);
    this.checkOrderOnItsFace(state, intent);
    const market = this.market(intent.symbol);
    const perp = market.kind === 'perpetual';
    const setting = perp ? state.leverage.get(market.symbol) : undefined;
    const builderFee = intent.builderFee ? { builder: intent.builderFee.builder.toLowerCase(), feeBps: intent.builderFee.feeBps } : null;
    const { lockAsset, lockAmount } = this.orderLock(market, intent, setting, builderFee);

    // Walk the contra book as `place` matches it: other accounts' resting orders that cross, best price first, then
    // time (this account's own crossing orders are cancelled first by self-trade prevention, so they are not met).
    const crosses = (o: OrderState) =>
      intent.side === 'buy' ? compare(o.order.price, intent.price) <= 0 : compare(o.order.price, intent.price) >= 0;
    const met = this.bookOf(market.symbol)
      .filter((o) => o.order.side !== intent.side && o.account !== state && crosses(o))
      .sort(
        (a, b) => (intent.side === 'buy' ? compare(a.order.price, b.order.price) : compare(b.order.price, a.order.price)) || a.seq - b.seq,
      );
    const takes: Array<{ qty: Amount; price: Amount }> = [];
    let left = intent.amount;
    for (const maker of met) {
      if (left === ZERO) break;
      const qty = min(left, maker.order.remaining);
      takes.push({ qty, price: maker.order.price });
      left = sub(left, qty);
    }
    const immediate = intent.type === 'market' || intent.timeInForce === 'IOC';
    const rests = left !== ZERO && !immediate ? left : ZERO;
    const role: 'maker' | 'taker' = takes.length > 0 || immediate ? 'taker' : 'maker';

    // Fees exactly as `fill` charges them: a spot buy pays in the base it receives, everything else in the quote.
    const feeInBase = market.kind === 'spot' && intent.side === 'buy';
    const feeAsset = feeInBase ? market.baseAsset : market.quoteAsset;
    const basisOf = (qty: Amount, price: Amount) => (feeInBase ? qty : mul(price, qty, QUOTE_ROUND));
    const line = (rate: (role: 'maker' | 'taker') => MaybeKnown<Amount>): MaybeKnown<VenueAssetAmount> => {
      let total = ZERO;
      for (const t of takes) {
        const r = rate('taker');
        if (!r.known) return { known: false };
        total = add(total, this.feeOn(basisOf(t.qty, t.price), r.value));
      }
      if (rests !== ZERO) {
        const r = rate('maker');
        if (!r.known) return { known: false };
        total = add(total, this.feeOn(basisOf(rests, intent.price), r.value));
      }
      return { known: true, value: { asset: feeAsset, amount: total } };
    };
    // What fills now, and its volume-weighted price, rounded against the customer (down on a sell, up on a buy).
    const against = intent.side === 'sell' ? 'floor' : 'ceil';
    const filled = takes.reduce((a, t) => add(a, t.qty), ZERO);
    const notional = takes.reduce((a, t) => add(a, mul(t.price, t.qty, against)), ZERO);
    const fill: VenueOrderPreview['fill'] = {
      known: true,
      value: { amount: filled, averagePrice: filled === ZERO ? null : div(notional, filled, against) },
    };
    const venueFee = line((r) => (r === 'maker' ? market.makerFeeBps : market.takerFeeBps));
    const zeroFee: MaybeKnown<Amount> = { known: true, value: ZERO };
    // No builder fee on a spot buy (see `fill`): known zero, whatever the order carries.
    const builderLine = line(() => (builderFee && !feeInBase ? { known: true, value: builderFee.feeBps } : zeroFee));

    let perpetual: VenueOrderPreview['perpetual'] = null;
    if (perp && setting) {
      const initialMargin = mul(this.marginPerUnit(intent, setting), intent.amount, QUOTE_ROUND);
      const held = state.positions.get(market.symbol);
      let after: PositionState | null;
      if (intent.reduceOnly) {
        // A partial close releases margin pro rata (`settle`), so the rest keeps its liquidation price.
        after = held && compare(held.size, intent.amount) > 0 ? { ...held, size: sub(held.size, intent.amount) } : null;
      } else if (held && held.size !== ZERO) {
        const size = add(held.size, intent.amount);
        after = {
          ...held,
          size,
          entryPrice: div(add(mul(held.entryPrice, held.size), mul(intent.price, intent.amount)), size, QUOTE_ROUND),
          margin: add(held.margin, initialMargin),
        };
      } else {
        after = {
          side: intent.side === 'buy' ? 'long' : 'short',
          size: intent.amount,
          entryPrice: intent.price,
          margin: initialMargin,
          leverageBps: setting.leverageBps,
          marginMode: setting.marginMode,
        };
      }
      perpetual = {
        leverageBps: setting.leverageBps,
        marginMode: setting.marginMode,
        initialMargin: { known: true, value: initialMargin },
        // No position left after a full close: there is no liquidation price to publish.
        liquidationPrice: after ? this.liquidationPrice(market, after) : { known: false },
      };
    }

    return this.asOf({
      symbol: market.symbol,
      kind: market.kind,
      lock: { asset: lockAsset, amount: lockAmount },
      role,
      venueFee,
      builderFee: builderLine,
      fill,
      perpetual,
    });
  }

  // ── UserVenue: signed actions ──────────────────────────────────────────

  async prepare(account: UserVenueAccount, signer: VenueSigner, intent: VenueIntent): Promise<PreparedVenueAction> {
    this.up();
    this.validate(account, signer, intent);
    const cloid =
      intent.kind === 'place_order' || intent.kind === 'cancel_order' ? venueClientOrderId(this.venue.id, intent.clientOrderKey) : null;
    const builderFee: PreparedVenueAction['builderFee'] =
      intent.kind === 'place_order' && intent.builderFee
        ? { builder: intent.builderFee.builder.toLowerCase(), feeBps: intent.builderFee.feeBps }
        : null;

    // Strictly increasing, and near the clock in microseconds, as a venue's nonce window expects.
    this.lastNonce = Math.max(this.lastNonce + 1, this.clock().getTime() * 1000);
    const nonce = String(this.lastNonce);
    const typedData = buildTypedData(this.venue.id, account, signer, intent, nonce, this.chainId);
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

  /**
   * Every check on an action's own face and on who may sign it, against the venue's record now. Run at prepare (so
   * the wallet is never asked to sign what must fail) and again at submit (prepare's checks are the caller's to skip:
   * the prepared object may be hand-built). Throws `VenueRefusalError`.
   */
  private validate(account: UserVenueAccount, signer: VenueSigner, intent: VenueIntent): void {
    if (account.venueId !== this.venue.id)
      refuse(this.venue.id, 'venue_rejected', `account is on ${account.venueId}, not ${this.venue.id}`);
    assertSignerMaySign(account, signer, intent);
    const state = this.account(account);
    if (signer.role === 'agent' && !this.agentLive(state, signer.address)) {
      refuse(this.venue.id, 'signer_not_authorised', `${signer.address.toLowerCase()} is not an approved, unexpired agent on this account`);
    }
    // An action on a sub-account needs the sub-account to exist under this owner. A withdrawal from one is refused
    // `not_offered` below whatever its state, so it keeps that one answer.
    if (account.subAccount !== null && intent.kind !== 'withdraw') this.subAccountOf(account.owner, account.subAccount);
    switch (intent.kind) {
      case 'place_order': {
        this.checkOrderOnItsFace(state, intent);
        venueClientOrderId(this.venue.id, intent.clientOrderKey); // refuses a key that is not a business key
        if (intent.builderFee) {
          if (compare(intent.builderFee.feeBps, ZERO) < 0) refuse(this.venue.id, 'venue_rejected', 'a builder fee cannot be negative');
          const cap = this.builderFeeCap(intent.symbol);
          if (cap !== null && compare(intent.builderFee.feeBps, cap) > 0) {
            refuse(
              this.venue.id,
              'builder_fee_above_cap',
              `${intent.symbol} caps a builder fee at ${formatAmount(cap)} bps; the order carries more`,
            );
          }
          const approved = state.builderApprovals.get(intent.builderFee.builder.toLowerCase()) ?? ZERO;
          // A spot buy pays no builder fee (see `fill`), so it needs no approval either.
          if (this.builderApplies(intent) && compare(approved, intent.builderFee.feeBps) < 0) {
            refuse(
              this.venue.id,
              'builder_fee_not_approved',
              `this account has approved ${approved} bps for the builder; the order carries more`,
            );
          }
        }
        return;
      }
      case 'update_leverage':
        this.checkLeverageOnItsFace(intent.symbol, intent.leverageBps, intent.marginMode);
        return;
      case 'withdraw':
        if (compare(intent.amount, ZERO) <= 0) refuse(this.venue.id, 'venue_rejected', 'a withdrawal must be positive');
        if (account.subAccount !== null) {
          refuse(this.venue.id, 'not_offered', 'a withdrawal from a sub-account is not offered: move the funds to the main account first');
        }
        return;
      case 'approve_builder_fee':
        if (compare(intent.maxFeeBps, ZERO) < 0) refuse(this.venue.id, 'venue_rejected', 'a builder fee approval cannot be negative');
        return;
      case 'amend_order':
        refuse(this.venue.id, 'not_offered', 'amend is not offered on the TEST venue simulator: cancel and place a new order');
      // falls through: refuse never returns
      case 'cancel_order':
        this.market(intent.symbol);
        venueClientOrderId(this.venue.id, intent.clientOrderKey); // refuses a key that is not a business key
        return;
      case 'approve_agent':
        this.checkAgentApproval(account, state, intent.agentAddress, intent.agentName, intent.validUntil);
        return;
      case 'revoke_agent':
        // Revoking an address that is not approved here would retire it for good without the owner meaning to.
        if (!state.agents.has(intent.agentAddress.toLowerCase())) {
          refuse(this.venue.id, 'venue_rejected', `${intent.agentAddress.toLowerCase()} is not an agent on this account`);
        }
        return;
      case 'create_sub_account': {
        const name = intent.name.trim();
        if (name === '') refuse(this.venue.id, 'venue_rejected', 'a sub-account needs a name');
        for (const existing of state.subAccounts.values()) {
          if (existing.name === name) refuse(this.venue.id, 'venue_rejected', `this owner already has a sub-account named "${name}"`);
        }
        return;
      }
      case 'sub_account_transfer':
        this.subAccountOf(account.owner, intent.subAccount);
        return;
    }
  }

  /** The owner's sub-account `id`, or `unknown_sub_account`. */
  private subAccountOf(owner: string, id: string): UserVenueSubAccount {
    const main = this.account({ venueId: this.venue.id, owner, subAccount: null });
    // Exact match: the venue's id as it named it, the same string the account's state and the signed bytes carry.
    const sub = main.subAccounts.get(id);
    if (!sub) refuse(this.venue.id, 'unknown_sub_account', `no sub-account ${id} under ${owner.toLowerCase()}`);
    return sub;
  }

  private checkAgentApproval(
    account: UserVenueAccount,
    state: AccountState,
    agentAddress: string,
    agentName: string,
    validUntil: Date | null,
  ): void {
    const address = agentAddress.toLowerCase();
    if (state.retiredAgents.has(address)) {
      refuse(
        this.venue.id,
        'venue_rejected',
        `agent ${address} was revoked or replaced on this account and is never approved again: use a new key`,
      );
    }
    if (address === state.owner) refuse(this.venue.id, 'venue_rejected', 'the owner wallet cannot be its own agent');
    if (validUntil !== null) {
      const now = this.clock().getTime();
      if (validUntil.getTime() <= now) refuse(this.venue.id, 'venue_rejected', 'an agent expiry must be in the future');
      if (validUntil.getTime() > now + MAX_AGENT_VALIDITY_MS) {
        refuse(this.venue.id, 'venue_rejected', 'an agent expiry is at most 180 days ahead');
      }
    }
    const name = agentName.trim();
    if (name === '') return; // the one unnamed agent: a new one replaces it
    // An expired agent signs nothing, so it holds no slot.
    const named = [...state.agents.values()].filter(
      (a) => a.name.trim() !== '' && a.address !== address && this.agentLive(state, a.address),
    );
    if (named.some((a) => a.name.trim() === name)) return; // replaces the key under that name
    const limit = account.subAccount === null ? MAX_NAMED_AGENTS_MAIN : MAX_NAMED_AGENTS_SUB;
    if (named.length >= limit) {
      refuse(this.venue.id, 'venue_rejected', `at most ${limit} named agents on this account: revoke one first`);
    }
  }

  async submit(prepared: PreparedVenueAction, signature: VenueSignature): Promise<VenueSubmitOutcome> {
    this.up();
    assertSignatureMatches(prepared, signature);
    // Recompute: the prepared action may have been edited after prepare.
    const typedData = buildTypedData(this.venue.id, prepared.account, prepared.signer, prepared.intent, prepared.nonce, this.chainId);
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
    this.assertNoNegativeBalance();
    byNonce.set(prepared.nonce, { digest, outcome });
    if (this.switches.loseAnswers > 0) {
      this.switches.loseAnswers -= 1;
      return { definite: false, reason: 'timeout' };
    }
    const lost = this.lostAnswers.get(key) ?? 0;
    if (lost > 0) {
      this.lostAnswers.set(key, lost - 1);
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

  /**
   * The TEST venue's own builder-fee totals for `builder` (OWNER 288 1e): every builder fee it charged on a fill that
   * carried that builder, per fee asset. No builder claims here, so all of it is unclaimed. The `builderTotalsUnknown`
   * switch answers not known.
   */
  async builderTotals(builder: string): Promise<AsOf<MaybeKnown<VenueBuilderTotals>>> {
    this.up();
    if (this.switches.builderTotalsUnknown) return this.asOf({ known: false });
    const b = builder.toLowerCase();
    const assets = [...(this.builderEarned.get(b) ?? new Map<string, Amount>()).entries()]
      .sort(([x], [y]) => x.localeCompare(y))
      .map(([asset, earned]) => ({ asset, earned, unclaimed: earned }));
    return this.asOf({ known: true, value: { builder: b, assets } });
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

  // ── UserVenueSubAccountReads ───────────────────────────────────────────

  async subAccounts(account: UserVenueAccount): Promise<AsOf<readonly UserVenueSubAccount[]>> {
    this.up();
    this.mainOnly(account);
    return this.asOf([...this.account(account).subAccounts.values()]);
  }

  async transfer(account: UserVenueAccount, nonce: string): Promise<AsOf<UserVenueTransfer | null>> {
    this.up();
    this.mainOnly(account);
    return this.asOf(this.account(account).transfers.get(nonce) ?? null);
  }

  private mainOnly(account: UserVenueAccount): void {
    if (account.subAccount !== null) refuse(this.venue.id, 'not_offered', 'sub-accounts and transfers are read on the main account');
  }

  // ── internals ──────────────────────────────────────────────────────────

  /** A balance below zero is money the venue made up: fail loudly, never report it. */
  private assertNoNegativeBalance(): void {
    for (const state of this.accounts.values()) {
      for (const [asset, b] of state.balances) {
        if (compare(b.free, ZERO) < 0 || compare(b.locked, ZERO) < 0) {
          throw new Error(`TEST simulator invariant: ${state.key} ${asset} free ${b.free} locked ${b.locked}`);
        }
      }
    }
  }

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

  /** The published rate, and the next settlement: the next whole interval after now on the venue's clock. */
  private fundingOf(funding: NonNullable<SimMarketConfig['funding']>): UserVenueFunding {
    const step = funding.intervalSeconds * 1000;
    const next = (Math.floor(this.clock().getTime() / step) + 1) * step;
    return { rate: funding.rate, intervalSeconds: funding.intervalSeconds, nextFundingAt: new Date(next) };
  }

  private feedOf(market: SimMarketConfig): UserVenueFeed {
    const since = this.staleSince.get(market.symbol);
    return {
      state: since ? 'stale' : 'live',
      lastOracleUpdateAt: since ?? this.clock(),
      staleRule: published(market.oracle?.staleRule),
    };
  }

  private sessionOf(market: SimMarketConfig): UserVenueSession {
    const session = market.session!;
    const closed = this.offHours.get(market.symbol);
    if (this.sessionUnpublished.has(market.symbol)) {
      return {
        state: closed ? 'off_hours' : 'open',
        homeMarket: session.homeMarket,
        offHoursMode: { known: false },
        offHoursBand: { known: false },
        offHoursMaxLeverageBps: null,
        reopensAt: null,
        offHoursRule: { known: false },
      };
    }
    return {
      state: closed ? 'off_hours' : 'open',
      homeMarket: session.homeMarket,
      offHoursMode: published(session.offHoursMode),
      offHoursBand: published(session.offHoursBand),
      offHoursMaxLeverageBps: session.offHoursMaxLeverageBps,
      reopensAt: closed?.reopensAt ?? null,
      offHoursRule: published(session.offHoursRule),
    };
  }

  /**
   * The venue's own off-hours rule on an opening order (`checkOrderOnItsFace`): while the home market is closed, no
   * market order, no leverage above the off-hours cap, no limit outside the band around the closing mark.
   */
  private checkOffHours(market: SimMarketConfig, intent: PlaceUserOrderIntent, leverageBps: number): void {
    const closed = this.offHours.get(market.symbol);
    if (!closed || intent.reduceOnly || !market.session) return;
    const session = market.session;
    // The venue's published rule, or (when it publishes none) its plain reason.
    const words = (why: string) =>
      (!this.sessionUnpublished.has(market.symbol) && session.offHoursRule) || `${market.symbol}'s home market is closed: ${why}`;
    if (intent.type === 'market') refuse(this.venue.id, 'market_off_hours', words('no market orders until it reopens'));
    if (leverageBps > session.offHoursMaxLeverageBps)
      refuse(this.venue.id, 'market_off_hours', words(`at most ${session.offHoursMaxLeverageBps / 10_000}x off hours`));
    const reach = div(mul(closed.closedMark, parseAmount(String(session.offHoursBandBps))), BPS, 'floor');
    if (compare(intent.price, add(closed.closedMark, reach)) > 0 || compare(intent.price, sub(closed.closedMark, reach)) < 0)
      refuse(this.venue.id, 'market_off_hours', words('the price is outside the off-hours band'));
  }

  /** The cap's refusal, in the venue's words: the market and the most it allows. */
  private aboveCap(market: SimMarketConfig, leverageBps: number): never {
    refuse(
      this.venue.id,
      'leverage_above_cap',
      `${market.symbol} allows at most ${(market.maxLeverageBps ?? 0) / 10_000}x; ${leverageBps / 10_000}x is above its cap`,
    );
  }

  private up(): void {
    if (this.switches.venueDown) refuse(this.venue.id, 'venue_down', `${this.venue.displayName} is down (TEST switch)`);
  }

  private asOf<T>(value: T): AsOf<T> {
    const at = this.clock();
    // The venue's own clock is the time of every read it gives (b2 change 6).
    return { venueId: this.venue.id, value, asOf: at, reportedAt: at };
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
        subAccounts: new Map(),
        transfers: new Map(),
        retiredAgents: new Set(),
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
    const own = this.marketState.get(market.symbol)!;
    if (own.status === 'halted') refuse(this.venue.id, 'market_halted', `${market.symbol} is halted on ${this.venue.displayName}`);
    if (own.status === 'cancel_only')
      refuse(this.venue.id, 'market_cancel_only', `${market.symbol} takes cancels only on ${this.venue.displayName}`);
    if (own.status === 'delisted') refuse(this.venue.id, 'market_delisted', `${market.symbol} is delisted on ${this.venue.displayName}`);
    if (own.maxOrderQty !== null && compare(intent.amount, own.maxOrderQty) > 0)
      refuse(this.venue.id, 'order_above_venue_max', `size is above the largest order on ${market.symbol}`);
    if (own.maxOrderNotional !== null && compare(mul(intent.amount, intent.price, 'ceil'), own.maxOrderNotional) > 0)
      refuse(this.venue.id, 'order_above_venue_max', `notional is above the largest order on ${market.symbol}`);
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
      const setting = state.leverage.get(market.symbol);
      if (!setting) {
        refuse(this.venue.id, 'leverage_not_set', `no leverage is set on ${market.symbol} for this account: set it first`);
      }
      if (!intent.reduceOnly && market.maxLeverageBps !== null && setting.leverageBps > market.maxLeverageBps)
        this.aboveCap(market, setting.leverageBps);
      // The venue's own off-hours rule, while the market's home market is closed.
      this.checkOffHours(market, intent, setting.leverageBps);
      // The venue's own stale-feed rule: while the oracle is stale, only reduce-only orders are taken.
      if (!intent.reduceOnly && market.oracle && this.staleSince.has(market.symbol)) {
        refuse(
          this.venue.id,
          'feed_stale',
          market.oracle.staleRule ?? `${market.symbol}'s oracle is stale: only reduce-only orders are taken until it updates`,
        );
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
    if (!Number.isInteger(leverageBps) || leverageBps % 10_000 !== 0 || leverageBps < 10_000) {
      refuse(this.venue.id, 'not_offered', `leverage ${leverageBps} bps is outside what ${symbol} offers`);
    }
    if (market.maxLeverageBps !== null && leverageBps > market.maxLeverageBps) this.aboveCap(market, leverageBps);
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

    // Every check runs again here, at submit, on the signed fields only: the prepared object is the caller's and may
    // have been edited or hand-built. Who signed (recovered from the bytes) must own the account or be its live agent.
    try {
      // A re-send of an order this account already placed answers with that order, after the signer's authority is
      // checked and before the face checks: a rule that changed since (a lowered builder approval) must not turn a
      // live order into a definite refusal.
      if (intent.kind === 'place_order') {
        assertSignerMaySign(prepared.account, prepared.signer, intent);
        if (prepared.signer.role === 'agent' && !this.agentLive(state, prepared.signer.address)) {
          return refused('signer_not_authorised', 'the agent key is not approved on this account, or has expired');
        }
        const placed = state.orders.get(venueClientOrderId(this.venue.id, intent.clientOrderKey));
        if (placed) return accepted(placed.order.venueOrderId, placed.order);
      }
      this.validate(prepared.account, prepared.signer, intent);
    } catch (error) {
      if (error instanceof VenueRefusalError) return refused(error.refusal.code, error.refusal.detail);
      throw error;
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
          if (this.builderApplies(intent) && compare(approved, builderFee.feeBps) < 0)
            return refused('builder_fee_not_approved', 'the builder fee approval no longer covers this order');
        }
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
        this.withdrawalFeeCharged.set(`${state.key}#${prepared.nonce}`, fee);
        const networkFee = this.switches.networkFee;
        this.networkFeeCharged.set(
          `${state.key}#${prepared.nonce}`,
          networkFee.known ? networkFee.value : this.switches.unpublishedNetworkFee,
        );
        this.withdrawalSubmittedAt.set(`${state.key}#${prepared.nonce}`, this.clock());
        const withdrawal: UserVenueWithdrawal = {
          nonce: prepared.nonce,
          asset: intent.asset,
          amount: intent.amount,
          destination: intent.destination.toLowerCase(),
          status: 'pending',
          fee: this.switches.withdrawalFee,
          networkFee,
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
      case 'approve_agent': {
        const address = intent.agentAddress.toLowerCase();
        const name = intent.agentName.trim();
        // A new key under a name in use (or a second unnamed key) replaces the old one, which is retired for good.
        for (const existing of [...state.agents.values()]) {
          if (existing.address !== address && existing.name.trim() === name) {
            state.agents.delete(existing.address);
            state.retiredAgents.add(existing.address);
          }
        }
        state.agents.set(address, { address, name: intent.agentName, validUntil: intent.validUntil });
        return accepted(null, null);
      }
      case 'revoke_agent': {
        const address = intent.agentAddress.toLowerCase();
        state.agents.delete(address);
        state.retiredAgents.add(address);
        return accepted(null, null);
      }
      case 'create_sub_account': {
        // The venue names it: deterministic from the owner and the signed nonce, so a replayed run names the same one.
        const id = `0x${createHash('sha256').update(`${this.venue.id}\u0000${state.owner}\u0000${prepared.nonce}`).digest('hex').slice(0, 40)}`;
        state.subAccounts.set(id, { subAccount: id, name: intent.name.trim() });
        this.account({ venueId: this.venue.id, owner: state.owner, subAccount: id });
        return accepted(id, null);
      }
      case 'sub_account_transfer': {
        const subState = this.account({ venueId: this.venue.id, owner: state.owner, subAccount: intent.subAccount });
        const into = intent.direction === 'into_sub_account';
        const fromState = into ? state : subState;
        // Read before creating: a refused move leaves no new balance row behind.
        if (compare(fromState.balances.get(intent.asset)?.free ?? ZERO, intent.amount) < 0) {
          return refused(
            'insufficient_balance',
            `free ${intent.asset} on the ${into ? 'main account' : 'sub-account'} does not cover the move (what is locked or held as margin stays)`,
          );
        }
        const from = this.balance(fromState, intent.asset);
        const to = this.balance(into ? subState : state, intent.asset);
        from.free = sub(from.free, intent.amount);
        to.free = add(to.free, intent.amount);
        state.transfers.set(prepared.nonce, {
          nonce: prepared.nonce,
          subAccount: intent.subAccount,
          direction: intent.direction,
          asset: intent.asset,
          amount: intent.amount,
          status: 'done',
          settledAt: this.clock(),
        });
        return accepted(prepared.nonce, null);
      }
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

    const { lockAsset, lockPerUnit, lockAmount } = this.orderLock(market, intent, setting, builderFee);
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

  /**
   * What the venue locks for an order: the quote notional (spot buy), the base (spot sell), or, on a perpetual, the
   * margin at the limit price plus the most the order can pay in fees. `place` and `preview` share it.
   */
  private orderLock(
    market: SimMarketConfig,
    intent: PlaceUserOrderIntent,
    setting: { leverageBps: number } | undefined,
    builderFee: PreparedVenueAction['builderFee'],
  ): { lockAsset: string; lockPerUnit: Amount; lockAmount: Amount } {
    // A perp order also locks the most it can pay in fees: the fee charged, even when the venue does not publish it.
    const maxFeeBps = add(this.chargedFeeBps(market, 'taker'), builderFee?.feeBps ?? ZERO);
    const feeBuffer = (notional: Amount) => div(mul(notional, maxFeeBps, QUOTE_ROUND), BPS, QUOTE_ROUND);
    let lockAsset: string;
    let lockPerUnit: Amount;
    if (market.kind === 'perpetual') {
      lockAsset = market.quoteAsset;
      lockPerUnit = add(this.marginPerUnit(intent, setting), feeBuffer(intent.price));
    } else if (intent.side === 'buy') {
      lockAsset = market.quoteAsset;
      lockPerUnit = intent.price;
    } else {
      lockAsset = market.baseAsset;
      lockPerUnit = parseAmount('1');
    }
    return { lockAsset, lockPerUnit, lockAmount: mul(lockPerUnit, intent.amount, QUOTE_ROUND) };
  }

  private marginPerUnit(intent: PlaceUserOrderIntent, setting: { leverageBps: number } | undefined): Amount {
    if (intent.reduceOnly) return ZERO;
    return div(mul(intent.price, BPS), parseAmount(String(setting!.leverageBps)), QUOTE_ROUND);
  }

  /** Whether the venue charges a builder fee on this order at all: never on a spot buy (project-state #1888). */
  private builderApplies(intent: PlaceUserOrderIntent): boolean {
    return !(this.market(intent.symbol).kind === 'spot' && intent.side === 'buy');
  }

  /** The venue's published builder-fee cap on `symbol`, or null when it publishes none. */
  private builderFeeCap(symbol: string): Amount | null {
    const cap = this.market(symbol).builderFeeCapBps;
    return cap?.known ? cap.value : null;
  }

  /** One fee line on `basis`, the same rounding `fill` charges. */
  private feeOn(basis: Amount, feeBps: Amount): Amount {
    return div(mul(basis, feeBps, QUOTE_ROUND), BPS, QUOTE_ROUND);
  }

  private bookOf(symbol: string): OrderState[] {
    return this.resting.get(symbol) as OrderState[];
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
      // As the venue does: a builder fee never applies to the buying side of a spot trade, only to a spot sell and to
      // both sides of a perp ("builder codes do not apply to the buying side of spot trades", Hyperliquid's
      // builder-codes page, read 9 Nov 2026; project-state #1888).
      const builderApplies = side.builderFee !== null && !feeInBase;
      let builderFee = builderApplies ? div(mul(feeBasis, side.builderFee!.feeBps, QUOTE_ROUND), BPS, QUOTE_ROUND) : ZERO;
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

      if (builderFee > ZERO) {
        const b = side.builderFee!.builder.toLowerCase();
        const asset = feeInBase ? market.baseAsset : market.quoteAsset;
        const byAsset = this.builderEarned.get(b) ?? new Map<string, Amount>();
        byAsset.set(asset, add(byAsset.get(asset) ?? ZERO, builderFee));
        this.builderEarned.set(b, byAsset);
      }
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
    // An oracle market's mark is the oracle price: a fill does not move it.
    if (market.kind === 'perpetual' && !market.oracle) this.marks.set(market.symbol, price);
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

/** A published word of the venue's, or `known: false` when it publishes none. */
function published<T>(value: T | undefined): MaybeKnown<T> {
  return value === undefined ? { known: false } : { known: true, value };
}

function isLive(o: OrderState): boolean {
  return o.order.status === 'open' || o.order.status === 'partially_filled';
}
