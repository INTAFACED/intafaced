import { createHash } from 'node:crypto';
import { add, compare, div, formatAmount, max, min, mul, parseAmount, sub, ZERO, type Amount } from '@intafaced/ledger-client/money';
import {
  type AgentPermissionReach,
  VenueRefusalError,
  VenueWireError,
  assertSignatureMatches,
  assertSignerMaySign,
  venueClientOrderId,
  ordersTakenTogether,
  type AsOf,
  type MaybeKnown,
  type VenueBuilderTotals,
  type UserVenueBuilderClaim,
  type PlaceUserOrderIntent,
  type PlaceUserOrdersIntent,
  type ReplaceUserOrderIntent,
  type CancelUserOrdersIntent,
  cancelsTakenTogether,
  type VenueLegOutcome,
  type PreparedVenueAction,
  type UserVenue,
  type UserVenueAccount,
  type UserVenueAgent,
  type UserVenueBalance,
  type UserVenueLockSplit,
  type UserVenueScheduledCancel,
  type UserVenueArrival,
  type UserVenueWithdrawalTerms,
  type UserVenueDeposit,
  type UserVenueDescriptor,
  type UserVenueFeed,
  type UserVenueFunding,
  type UserVenueFundingPayment,
  type VenuePriceSample,
  type VenueFundingRow,
  type UserVenueFill,
  type UserVenueLeverage,
  type UserVenueLeverageChange,
  type UserVenueIsolatedMargin,
  type UserVenueAccountSummary,
  type UserVenueAdlRules,
  type UserVenueDeleverage,
  type UserVenueInsuranceFund,
  type UserVenueLiquidation,
  type UserVenueLiquidationPart,
  type UserVenueLiquidationStatus,
  type VenueLiquidationAlert,
  type UserVenueListing,
  type UserVenueMarginAccountRule,
  type UserVenueMarginTier,
  type UserVenueCollateral,
  type UserVenueMarketMargin,
  type UserVenueMarketEvent,
  type UserVenueSettlement,
  type UserVenueMarket,
  type UserVenueMarketStatus,
  type UserVenueOrder,
  type UserVenueOrderRecord,
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
  type VenueFeeRates,
  type VenueFeeTiers,
  type VenueFeeStatus,
  type VenueOtherFee,
  type VenueBestPrices,
  type VenueMarginMode,
  type VenueRefusalCode,
  type VenueSignature,
  type VenueSigner,
  type VenueSubmitOutcome,
  type VenueTrigger,
  type VenueTriggerSource,
  type VenueCandle,
  type VenueCandleInterval,
  type VenuePrint,
  VENUE_CANDLE_INTERVALS,
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
 *   · a market with its deployer's own margin account (`marginAccount`, a
 *     HIP-3 deployer's margin kept apart from the main account): its orders
 *     lock, post and settle margin in that account, funded only by the
 *     owner's signed `market_margin_transfer` (`marketMargin` reads it);
 *   · `setOpenInterestCap(symbol, cap)` — the deployer's cap on the market's
 *     open interest (the long size open, in base units): an opening order that
 *     would pass it refuses `open_interest_above_cap`, naming the cap;
 *   · `settleMarket(symbol, 'deployer_halt' | 'split')` — the market's deployer
 *     halts it, or a split in what it tracks: every order on the market is
 *     cancelled and every position settled at the mark, each account's
 *     settlement recorded (`settlements`) and the event published
 *     (`lastEvent`). A halt leaves the market `halted` until
 *     `setMarketStatus(symbol, 'trading')` resumes it; a split reopens it at
 *     once with its mark divided by the ratio.
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
   * settlement at the next whole interval on the venue's clock. Unset: not published. TEST: on a market without `settles`
   * the simulator publishes the rate and settles no funding, so no TEST position there is ever charged or paid it.
   *
   * With `settles` (J-derivatives-08), the venue builds the rate itself and settles it: the rate is the premium (how far
   * the mark sits from the index, `(mark − index) / index`, to eight places toward zero) plus `interestRate`, held within
   * `rateCap` either way, and `rate` is unused. It publishes those inputs with the rate, and closes a period on the TEST
   * control `settleFunding`, booking one payment per open position: size × mark × rate, to six places toward zero, paid
   * by longs and received by shorts on a positive rate (the other way on a negative one), on the position's margin.
   */
  readonly funding?: {
    readonly rate: Amount;
    readonly intervalSeconds: number;
    readonly settles?: { readonly interestRate: Amount; readonly rateCap: Amount; readonly rule?: string };
  };
  /** The market's own state at start; absent is `trading`. */
  readonly status?: UserVenueMarketStatus | null;
  /** The largest order size (base) and notional (quote) at start; absent is `null` (not reported). TEST figures. */
  readonly maxOrderQty?: Amount | null;
  readonly maxOrderNotional?: Amount | null;
  /**
   * The venue's published smallest order value (quote), price band (scaled bps around the middle of its own book) and
   * most open orders per account, at start; absent is `null` (not published, and not enforced). TEST figures.
   */
  readonly minOrderNotional?: Amount | null;
  readonly priceBandBps?: Amount | null;
  readonly maxOpenOrders?: number | null;
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
  /**
   * Set on a market whose deployer keeps its own margin account for it (a HIP-3 deployer's margin, apart from the main
   * account): its name, collateral asset and margin mode. Orders on it draw on that account only.
   */
  readonly marginAccount?: UserVenueMarginAccountRule;
  /** The deployer's cap on the market's open interest at start, in base units; absent: no open interest is reported. */
  readonly openInterestCap?: Amount | null;
  /**
   * Perpetuals: the prices the venue judges its trigger orders on (`VenueTrigger`). Absent or empty: it takes no trigger
   * order on this market, and one refuses `not_offered`.
   */
  readonly triggerSources?: readonly VenueTriggerSource[];
  /**
   * Perpetuals: the venue's published margin tiers, lowest `fromNotional` first (the first from zero). Set, they are the
   * venue's rule: a position's maintenance margin is its tier's rate (not `maintenanceMarginRate`), and an opening order
   * whose position notional would reach a tier above the account's leverage refuses `leverage_above_cap`, naming the
   * tier. Unset: none published, and the flat `maintenanceMarginRate` applies.
   */
  readonly marginTiers?: readonly UserVenueMarginTier[];
  /** What the venue publishes it takes as margin on this market, each with its haircut. Unset: no list published. */
  readonly collateral?: readonly UserVenueCollateral[];
  /**
   * Perpetuals: set on a market the TEST venue liquidates on (J-derivatives-07), with its published words. When the mark
   * reaches a position's liquidation price the venue closes half of it at the mark, and the rest at the next mark it sets;
   * each part pays `feeRate` of its value at the mark, capped at the margin that part leaves, into the TEST insurance fund,
   * and the fund pays a loss past the part's margin, up to what it holds. Unset: the venue liquidates nothing there.
   */
  readonly liquidation?: { readonly feeRate: Amount; readonly priceRule: string; readonly feeRule: string };
}

/** TEST: the venue's insurance fund at start (J-derivatives-07 #4), in USDC. A TEST figure; it holds nothing anywhere. */
export const TEST_INSURANCE_FUND_START = '100000';

/** TEST: the auto-deleveraging rules the TEST venue publishes at start, and their version (J-derivatives-07 #5). */
export const TEST_ADL_RULES: UserVenueAdlRules = {
  version: 'TEST-adl-1',
  text:
    'TEST rule: when a liquidation leaves a loss the insurance fund does not cover, the venue closes positions on the other ' +
    "side, the most profitable and most leveraged first, at the liquidated position's bankruptcy price, and sends each " +
    'account a notice. No fee is charged on an auto-deleveraging close.',
};

/** The public liquidation and auto-deleveraging alerts the simulator keeps, newest last. */
const ALERTS_KEPT = 500;

/**
 * TEST: how old the TEST venue says its figures may be before they are stale (b2 change 6). A real venue's adapter
 * declares its own; this TEST value stands in on test stacks only.
 */
export const TEST_VENUE_FIGURE_STALE_AFTER_MS = 60_000;

/**
 * TEST: the longest an agent permission with an end date may last on the TEST venue (J-agents-21 #19), 180 days. A real
 * venue's adapter declares its own; this TEST value stands in on test stacks only.
 */
export const TEST_VENUE_AGENT_VALIDITY_MAX_MS = 180 * 24 * 60 * 60 * 1000;

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
   * How long the venue publishes a withdrawal takes to arrive, in seconds (J-bank-31 #3); `null` publishes none, read as
   * "not published". TEST: the TEST venue pays a withdrawal about 4 seconds after it is signed (chain-deposits.ts).
   */
  withdrawalArrivalSeconds: number | null;
  /** TEST: the chain sender pays out no withdrawal while true, so each stays pending until it goes back (J-bank-31 #4). */
  withdrawalsHeld: boolean;
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
  /** The venue publishes no settlement or other fees beside its trading fees (J-derivatives-12 #2); it still charges them. */
  otherFeesUnpublished: boolean;
  loseAnswers: number;
}

export interface SimOptions {
  readonly id?: string;
  /** The venue's published fee tiers (J-cex-spot-10). Default: none published. */
  readonly feeSchedule?: VenueFeeTiers;
  readonly displayName?: string;
  readonly clock: () => Date;
  readonly markets: readonly SimMarketConfig[];
  readonly switches?: Partial<SimSwitches>;
  /** The EIP-712 domain's chain id (signing.ts). Default `TEST_VENUE_CHAIN_ID`. */
  readonly chainId?: number;
  /**
   * The most orders this TEST venue takes in one signed action (`place_orders`), as its descriptor declares it. Default:
   * none declared, so it takes one order per signature.
   */
  readonly ordersPerAction?: number;
  /** True when this TEST venue lowers a resting order's amount in place (`amend_order`), as its descriptor declares it. */
  readonly amendsInPlace?: boolean;
  /** The most orders this TEST venue cancels in one signed action (`cancel_orders`). Default: none declared. */
  readonly cancelsPerAction?: number;
  /**
   * The least time ahead this TEST venue takes a scheduled cancel (`schedule_cancel`, J-cex-spot-07), in ms. Default: none
   * declared, so it offers no scheduled cancel.
   */
  readonly scheduledCancelMinLeadMs?: number;
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
  /** Every credit from outside the account (a deposit), oldest first: the venue's own record of it (J-portfolio-02 #6). */
  readonly arrivals: UserVenueArrival[];
  readonly leverage: Map<string, { leverageBps: number; marginMode: VenueMarginMode }>;
  /** Main account only: its sub-accounts, by venue id. */
  readonly subAccounts: Map<string, UserVenueSubAccount>;
  /** Main account only: moves to and from its sub-accounts, by signed nonce. */
  readonly transfers: Map<string, UserVenueTransfer>;
  /** Agent addresses revoked or replaced on this account: never approved here again. */
  readonly retiredAgents: Set<string>;
  /** Main account only: its balance in each market deployer's own margin account, by the margin account's name. */
  readonly marketMargins: Map<string, { free: Amount; locked: Amount }>;
  /** TEST only (J-portfolio-01 #4): coins staked on the venue, by asset. Staked coins stay in the balance, as locked. */
  readonly stakes: Map<string, Amount>;
  /** TEST only: the stake references already taken, so the same TEST stake is taken once. */
  readonly stakeRefs: Set<string>;
  /**
   * TEST only (J-campaigns-19 #5): a loss past margin the venue booked as a deficit, by asset. It is kept apart from the
   * balances, which never go below zero, and reported against them: the account's reported balance there may be negative.
   */
  readonly deficits: Map<string, Amount>;
  /** Its settlements in market events (a deployer's halt, a split), oldest first. */
  readonly settlements: UserVenueSettlement[];
  /** Its scheduled cancel (J-cex-spot-07): when the venue cancels every open order, and what it last did. */
  scheduled: { cancelsAt: Date | null; lastFired: { firedAt: Date; canceled: number } | null };
  /**
   * The fee tier the venue last placed this account in (J-cex-spot-10 #6): the tier's index in the published schedule,
   * the volume it counted and when. `null` until the venue's first update: the base tier.
   */
  feeTier: { index: number; volume: Amount; updatedAt: Date } | null;
  /** Its liquidations, oldest first, each with the parts the venue closed (J-derivatives-07 #2). */
  readonly liquidations: {
    liquidationId: string;
    symbol: string;
    side: 'long' | 'short';
    state: 'in_progress' | 'done';
    parts: UserVenueLiquidationPart[];
    startedAt: Date;
  }[];
  /** Its auto-deleveragings, oldest first, with the venue's notice (J-derivatives-07 #6). */
  readonly deleverages: UserVenueDeleverage[];
  /** The funding the venue booked on its positions, oldest first, one per position per period closed (J-derivatives-08). */
  readonly fundingPayments: UserVenueFundingPayment[];
}

interface OrderState {
  order: UserVenueOrder;
  readonly account: AccountState;
  readonly seq: number;
  /** When the venue took the order (its order history, J-cex-spot-06 #1). */
  readonly placedAt: Date;
  readonly builderFee: { readonly builder: string; readonly feeBps: Amount } | null;
  readonly leverageBps: number | null;
  readonly marginMode: VenueMarginMode | null;
  /** What the order locks per unit of size: the quote notional (spot buy), 1 (spot sell), or margin plus the most fees (perp). */
  readonly lockPerUnit: Amount;
  /** The deployer margin account the order's lock sits in (a market with `marginAccount`), or `null`: the main balances. */
  readonly marginAccount: string | null;
  /** A trigger order attached to an entry: the entry, and the size the person asked for (it arms on what the entry filled). */
  readonly parent?: OrderState | null;
  readonly requested?: Amount;
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

/** How far back the TEST funding history reaches, and its most rows per read (J-charts-desk-04 #6). TEST. */
const FUNDING_HISTORY_MS = 24 * 3_600_000;
const FUNDING_HISTORY_ROWS = 500;
/** The most mark and index samples the TEST venue keeps per perpetual (J-derivatives-08 #6). TEST. */
const PRICE_SAMPLES_KEPT = 500;

/** `value` cut toward zero to `18 − drop` decimal places. */
function truncate(value: Amount, drop: number): Amount {
  const q = 10n ** BigInt(drop);
  return value - (value % q);
}
/** The public prints the simulator keeps per market, newest last; the tape and the candles read from these. */
const PRINTS_KEPT = 5_000;
/** The most prints or candles one read answers. */
const MARKET_READ_MAX = 500;

const NO_RATES: VenueFeeRates = { makerFeeBps: { known: false }, takerFeeBps: { known: false } };

function refuse(venueId: string, code: VenueRefusalCode, detail: string): never {
  throw new VenueRefusalError({ venueId, code, detail });
}

function accountKey(account: UserVenueAccount): string {
  return `${account.owner.toLowerCase()}/${account.subAccount ?? ''}`;
}

export class TestVenueSimulator implements UserVenue, UserVenueSubAccountReads {
  venue: UserVenueDescriptor;
  readonly switches: SimSwitches;

  /**
   * TEST: what the descriptor declares as an agent permission's reach (`agentPermissionReach`), so a journey can show
   * what the app tells a person on a venue whose permission reaches their other accounts (J-agents-21 #3). The
   * declaration only: the simulator's own agents stay live on the one account they were approved on (`agentLive`).
   */
  declareAgentPermissionReach(reach: AgentPermissionReach): void {
    this.venue = { ...this.venue, agentPermissionReach: reach };
  }
  /**
   * TEST: whether the descriptor declares an amend in place (`amendsInPlace`), so a journey can show the app's other branch,
   * a reviewed cancel-and-replace, against the same running venue (J-cex-spot-05 #2). A door reads it when it connects.
   */
  declareAmendsInPlace(on: boolean): void {
    const { amendsInPlace: _dropped, ...rest } = this.venue;
    this.venue = on ? { ...rest, amendsInPlace: true } : rest;
  }
  /**
   * TEST: how many cancels the descriptor declares it takes in one signed action (`cancelsPerAction`); `null` declares
   * none, so a cancel goes one per signature. A door reads it when it connects (J-cex-spot-05 #5, #6).
   */
  declareCancelsPerAction(n: number | null): void {
    const { cancelsPerAction: _dropped, ...rest } = this.venue;
    this.venue = n === null ? rest : { ...rest, cancelsPerAction: n };
  }
  /**
   * TEST: whether the descriptor declares a scheduled cancel, and the least time ahead it takes one (J-cex-spot-07 #1:
   * "not offered by this venue" where it has none). `null` declares none. A door reads it when it connects.
   */
  declareScheduledCancel(minLeadMs: number | null): void {
    const { scheduledCancel: _dropped, ...rest } = this.venue;
    this.venue = minLeadMs === null ? rest : { ...rest, scheduledCancel: { minLeadMs } };
  }

  /**
   * The venue's own scheduled cancels that reached their time: every open order of each such account is cancelled once
   * and its lock released, whatever placed it, and the schedule is cleared. Run on every call to the venue and on the
   * server's own timer, so it fires when nobody is talking to the venue. Returns how many orders it cancelled.
   */
  runScheduledCancels(): number {
    const now = this.clock();
    let total = 0;
    for (const state of this.accounts.values()) {
      const at = state.scheduled.cancelsAt;
      if (at === null || at.getTime() > now.getTime()) continue;
      let canceled = 0;
      for (const order of state.orders.values()) {
        if (!isLive(order)) continue;
        this.release(order, 'canceled', 'scheduled_cancel');
        canceled += 1;
      }
      state.scheduled = { cancelsAt: null, lastFired: { firedAt: now, canceled } };
      total += canceled;
    }
    return total;
  }

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
  /** The venue's published fee tiers and how it counts volume (J-cex-spot-10 #2 #6). */
  private feeSchedule: VenueFeeTiers = { tiers: null, volumeAsset: 'USDC', volumeDays: 14 };
  private readonly submitted = new Map<string, Map<string, SubmittedRecord>>(); // account → nonce → record
  /** TEST: who signed each order the venue accepted, as recovered from its bytes (account → client order id → signer). */
  private readonly orderSigners = new Map<string, Map<string, VenueSigner>>();
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
  /** Builder fee claims, by builder address, oldest first: the venue's own claim record (J-derivatives-17). */
  private readonly builderClaimRecord = new Map<string, UserVenueBuilderClaim[]>();
  private builderClaimCounter = 0;
  private venueOrderCounter = 0;
  /** Each market's own state and largest order, changed by the TEST controls. */
  private readonly marketState = new Map<
    string,
    {
      status: UserVenueMarketStatus | null;
      maxOrderQty: Amount | null;
      maxOrderNotional: Amount | null;
      minOrderNotional: Amount | null;
      priceBandBps: Amount | null;
      maxOpenOrders: number | null;
    }
  >();
  /** Each market's deployer cap on its open interest (base units; `null`: none set), for a market that reports one. */
  private readonly openInterestCaps = new Map<string, Amount | null>();
  /** Each market's latest halt or split that settled its positions (`settleMarket`). */
  private readonly marketEvents = new Map<string, UserVenueMarketEvent>();
  /** Each perpetual's last traded price, the `last` trigger source; absent until its first fill. */
  private readonly lastTrades = new Map<string, Amount>();
  /** Every market's public prints, oldest first, at most `PRINTS_KEPT` (J-cex-spot-01 #5: the tape, ticker and chart). */
  private readonly prints = new Map<string, VenuePrint[]>();
  private printCounter = 0;
  /** Each perpetual's TEST index (oracle) price, as the venue publishes it (`setIndex`); it starts at the market's mark. */
  private readonly indexes = new Map<string, Amount>();
  /** Trigger orders waiting for their source to cross their price, by market. They are not on the book. */
  private readonly triggers = new Map<string, OrderState[]>();
  /** Set while trigger orders are being fired, so a fill a trigger order makes never fires another from inside it. */
  private firing = false;
  /** TEST: the venue's insurance fund (J-derivatives-07 #4): what it holds, and whether the venue publishes it. */
  private insurance: { balance: Amount; published: boolean } = { balance: parseAmount(TEST_INSURANCE_FUND_START), published: true };
  /** TEST: the auto-deleveraging rules the venue publishes, `null` for none (J-derivatives-07 #5). */
  private adl: UserVenueAdlRules | null = TEST_ADL_RULES;
  /** Public liquidation and auto-deleveraging alerts, oldest first, at most `ALERTS_KEPT`, with no account (#7). */
  private readonly alerts: VenueLiquidationAlert[] = [];
  private liquidationCounter = 0;
  private adlCounter = 0;
  /**
   * Funding on a market that settles it (J-derivatives-08): whether the venue publishes it now, the next period it closes
   * (ms on its clock; set at the first read), and each period it closed with a rate, oldest first.
   */
  private readonly fundingState = new Map<string, { published: boolean; nextAt: number | null; settled: VenueFundingRow[] }>();
  private fundingCounter = 0;
  /** Each perpetual's mark and index as the venue published them, oldest first, at most `PRICE_SAMPLES_KEPT` (J-derivatives-08 #6). */
  private readonly priceSamples = new Map<string, { mark: VenuePriceSample[]; index: VenuePriceSample[] }>();
  /** Perpetuals whose index the venue does not publish now (`setIndexPublished`). */
  private readonly indexUnpublished = new Set<string>();

  constructor(options: SimOptions) {
    const id = options.id ?? 'test-venue-sim';
    this.venue = {
      id,
      displayName: options.displayName ?? 'TEST venue simulator',
      kind: 'external-dex',
      sequencedDepth: true,
      proofLevel: 'simulator',
      figureStaleAfterMs: TEST_VENUE_FIGURE_STALE_AFTER_MS,
      agentValidityMaxMs: TEST_VENUE_AGENT_VALIDITY_MAX_MS,
      // An agent approved on a sub-account is live only in that account's state (`agentLive`), so it trades nothing else.
      agentPermissionReach: 'own_account_only',
      // As the venue it stands for: one net position per contract (no hedge mode).
      positionModes: ['one_way'],
      ...(options.ordersPerAction !== undefined ? { ordersPerAction: options.ordersPerAction } : {}),
      ...(options.amendsInPlace ? { amendsInPlace: true } : {}),
      ...(options.cancelsPerAction !== undefined ? { cancelsPerAction: options.cancelsPerAction } : {}),
      ...(options.scheduledCancelMinLeadMs !== undefined ? { scheduledCancel: { minLeadMs: options.scheduledCancelMinLeadMs } } : {}),
    };
    this.clock = options.clock;
    if (options.feeSchedule) this.setFeeSchedule(options.feeSchedule);
    this.chainId = testVenueDomain(options.chainId ?? TEST_VENUE_CHAIN_ID).chainId;
    this.switches = {
      venueDown: false,
      builderTotalsUnknown: false,
      unlistPerpetuals: false,
      withdrawalFee: { known: true, value: parseAmount('1') },
      unpublishedWithdrawalFee: parseAmount('2'),
      networkFee: { known: true, value: parseAmount('0.25') },
      withdrawalArrivalSeconds: 60,
      withdrawalsHeld: false,
      depositExplorerTxUrl: null,
      unpublishedNetworkFee: parseAmount('0.5'),
      unpublishedMakerFeeBps: parseAmount('2'),
      unpublishedTakerFeeBps: parseAmount('5'),
      otherFeesUnpublished: false,
      loseAnswers: 0,
      ...options.switches,
    };
    for (const market of options.markets) {
      this.marketsBySymbol.set(market.symbol, market);
      this.resting.set(market.symbol, []);
      this.triggers.set(market.symbol, []);
      if (market.markPrice !== undefined) this.marks.set(market.symbol, market.markPrice);
      if (market.kind === 'perpetual' && market.markPrice !== undefined) this.indexes.set(market.symbol, market.markPrice);
      this.samplePrices(market.symbol);
      this.marketState.set(market.symbol, {
        status: market.status === undefined ? 'trading' : market.status,
        maxOrderQty: market.maxOrderQty ?? null,
        maxOrderNotional: market.maxOrderNotional ?? null,
        minOrderNotional: market.minOrderNotional ?? null,
        priceBandBps: market.priceBandBps ?? null,
        maxOpenOrders: market.maxOpenOrders ?? null,
      });
      if (market.openInterestCap !== undefined) this.openInterestCaps.set(market.symbol, market.openInterestCap);
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
    this.triggers.set(market.symbol, []);
    if (market.markPrice !== undefined) this.marks.set(market.symbol, market.markPrice);
    if (market.kind === 'perpetual' && market.markPrice !== undefined) this.indexes.set(market.symbol, market.markPrice);
    this.samplePrices(market.symbol);
    this.marketState.set(market.symbol, {
      status: market.status === undefined ? 'trading' : market.status,
      maxOrderQty: market.maxOrderQty ?? null,
      maxOrderNotional: market.maxOrderNotional ?? null,
      minOrderNotional: market.minOrderNotional ?? null,
      priceBandBps: market.priceBandBps ?? null,
      maxOpenOrders: market.maxOpenOrders ?? null,
    });
    if (market.openInterestCap !== undefined) this.openInterestCaps.set(market.symbol, market.openInterestCap);
  }

  /** TEST control: the market's own state (`null`: the venue reports none). Changes no order. */
  setMarketStatus(symbol: string, status: UserVenueMarketStatus | null): void {
    this.market(symbol);
    this.marketState.get(symbol)!.status = status;
    // Resuming a market its deployer halted: the venue reports when it reopened.
    const event = this.marketEvents.get(symbol);
    if (status === 'trading' && event && event.reopenedAt === null) this.marketEvents.set(symbol, { ...event, reopenedAt: this.clock() });
  }

  /**
   * TEST control: the market's deployer halts it (`deployer_halt`), or a split in what it tracks (`split`, by `ratio`).
   * The venue cancels every order on the market and settles every position at the mark now, as the venue does on a
   * HIP-3 deployer's halt: each account's margin and realised result return to where its margin was held, and each
   * account's settlement is recorded with the orders it lost. A halt leaves the market `halted` until it is resumed; a
   * split reopens it at once, its mark divided by the ratio. Only a perpetual with a mark.
   */
  settleMarket(symbol: string, kind: UserVenueMarketEvent['kind'], ratio?: Amount): UserVenueMarketEvent {
    const market = this.market(symbol);
    if (market.kind !== 'perpetual') refuse(this.venue.id, 'not_offered', `${symbol} is cash spot: there is no position to settle`);
    const mark = this.marks.get(symbol);
    if (mark === undefined) throw new Error(`TEST simulator: ${symbol} has no mark to settle at`);
    if (kind === 'split' && (ratio === undefined || compare(ratio, ZERO) <= 0))
      refuse(this.venue.id, 'venue_rejected', 'a split needs a ratio above zero');
    const at = this.clock();
    const cancelled = new Map<AccountState, (string | null)[]>();
    for (const order of [...this.bookOf(symbol), ...(this.triggers.get(symbol) ?? [])]) {
      this.release(order, 'canceled');
      cancelled.set(order.account, [...(cancelled.get(order.account) ?? []), order.order.venueClientOrderId]);
    }
    for (const state of this.accounts.values()) {
      const p = state.positions.get(symbol);
      const held = p && p.size !== ZERO ? p : null;
      const lost = cancelled.get(state) ?? [];
      if (!held && lost.length === 0) continue;
      let realisedPnl = ZERO;
      if (held) {
        // Isolated: the loss stops at the position's margin, which returns with the result to where it was held.
        realisedPnl = max(this.pnl(held, mark, held.size), sub(ZERO, held.margin));
        const balance = this.lockBalance(
          state,
          market.marginAccount?.name ?? null,
          market.marginAccount?.collateralAsset ?? market.quoteAsset,
        );
        balance.locked = sub(balance.locked, held.margin);
        balance.free = add(balance.free, add(held.margin, realisedPnl));
      }
      state.settlements.push({
        symbol,
        kind,
        side: held ? held.side : null,
        size: held ? held.size : ZERO,
        price: mark,
        realisedPnl,
        cancelledOrders: lost,
        settledAt: at,
      });
      if (held) {
        held.size = ZERO;
        held.margin = ZERO;
      }
    }
    const event: UserVenueMarketEvent = {
      kind,
      eventAt: at,
      settlementPrice: mark,
      reopenedAt: null,
      splitRatio: kind === 'split' ? formatAmount(ratio!) : null,
    };
    if (kind === 'deployer_halt') {
      this.marketState.get(symbol)!.status = 'halted';
      this.marketEvents.set(symbol, event);
    } else {
      // The split's new mark, rounded down to the market's tick; the market reopens on it at once.
      const split = div(mark, ratio!, 'floor');
      this.marks.set(symbol, split - (split % market.tickSize));
      this.samplePrices(symbol);
      this.marketState.get(symbol)!.status = 'trading';
      this.marketEvents.set(symbol, { ...event, reopenedAt: this.clock() });
    }
    return this.marketEvents.get(symbol)!;
  }

  /** TEST control: the trading fees this market publishes; `known: false` publishes none (the venue still charges its unpublished rate). */
  setMarketFees(symbol: string, fees: { makerFeeBps: MaybeKnown<Amount>; takerFeeBps: MaybeKnown<Amount> }): void {
    const market = this.market(symbol);
    this.marketsBySymbol.set(symbol, { ...market, makerFeeBps: fees.makerFeeBps, takerFeeBps: fees.takerFeeBps });
  }

  /**
   * TEST control: the prices a trigger order on this perpetual may be judged on (J-cex-spot-06 #6 turns them on for
   * BTC-PERP for its file and back off after it). `[]` takes no trigger order there. A waiting trigger order stays as it is.
   */
  setTriggerSources(symbol: string, sources: readonly VenueTriggerSource[]): void {
    const market = this.market(symbol);
    if (market.kind !== 'perpetual') refuse(this.venue.id, 'not_offered', `${symbol} is cash spot: no trigger orders`);
    this.marketsBySymbol.set(symbol, { ...market, triggerSources: [...new Set(sources)] });
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

  /**
   * TEST control: the deployer's cap on a market's open interest, in base units (`null`: no cap). Only on a market that
   * reports its open interest. Changes no order or position: it bounds the next opening order.
   */
  setOpenInterestCap(symbol: string, cap: Amount | null): void {
    this.market(symbol);
    if (!this.openInterestCaps.has(symbol)) refuse(this.venue.id, 'not_offered', `${symbol} reports no open interest`);
    if (cap !== null && compare(cap, ZERO) <= 0) refuse(this.venue.id, 'venue_rejected', 'an open-interest cap must be positive');
    this.openInterestCaps.set(symbol, cap);
  }

  /**
   * TEST control: the market's largest order size and notional, and its smallest order value, price band and open-order
   * cap (`null`: not reported). A rule left out is kept as it is. Changes no order.
   */
  setMarketLimits(
    symbol: string,
    limits: {
      maxOrderQty?: Amount | null;
      maxOrderNotional?: Amount | null;
      minOrderNotional?: Amount | null;
      priceBandBps?: Amount | null;
      maxOpenOrders?: number | null;
    },
  ): void {
    this.market(symbol);
    const state = this.marketState.get(symbol)!;
    if (limits.maxOrderQty !== undefined) state.maxOrderQty = limits.maxOrderQty;
    if (limits.maxOrderNotional !== undefined) state.maxOrderNotional = limits.maxOrderNotional;
    if (limits.minOrderNotional !== undefined) state.minOrderNotional = limits.minOrderNotional;
    if (limits.priceBandBps !== undefined) state.priceBandBps = limits.priceBandBps;
    if (limits.maxOpenOrders !== undefined) state.maxOpenOrders = limits.maxOpenOrders;
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
    state.arrivals.push({ arrivalId: depositRef, kind: 'deposit', asset, amount, arrivedAt: this.clock() });
    return true;
  }

  /**
   * TEST only (J-campaigns-19 #5): a loss past the account's margin that the venue booked as a deficit, once per
   * `lossRef`. The asset's reported free balance falls by `amount` and may go below zero, so the account's equity there
   * is negative, as a venue reports one whose loss outran its collateral. The deficit is held apart from the balances the
   * simulator trades on, so its no-negative-balance invariant still holds for every account. Nothing else changes.
   */
  bookDeficit(account: UserVenueAccount, asset: string, amount: Amount, lossRef: string): boolean {
    if (compare(amount, ZERO) <= 0) refuse(this.venue.id, 'venue_rejected', 'a deficit must be positive');
    const state = this.account(account);
    if (state.deposits.has(`deficit:${lossRef}`)) return false;
    state.deposits.add(`deficit:${lossRef}`);
    state.deficits.set(asset, add(state.deficits.get(asset) ?? ZERO, amount));
    return true;
  }

  /** The coins credited to this account from outside it, oldest first (J-portfolio-02 #6): each deposit it credited. */
  async arrivals(account: UserVenueAccount): Promise<AsOf<readonly UserVenueArrival[]>> {
    this.up();
    return this.asOf([...this.account(account).arrivals]);
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
    this.samplePrices(symbol);
    // A trigger order judged on the mark fires as soon as the mark crosses it.
    this.runTriggers();
    // Then the venue liquidates, on a market it liquidates on, what the new mark reaches (J-derivatives-07).
    this.runLiquidations(symbol);
  }

  /** TEST control: the perpetual's TEST index (oracle) price, as the venue publishes it. No venue trigger is judged on it. */
  setIndex(symbol: string, price: Amount): void {
    const market = this.market(symbol);
    if (market.kind !== 'perpetual') refuse(this.venue.id, 'not_offered', `${symbol} is cash spot: it has no index`);
    if (compare(price, ZERO) <= 0) refuse(this.venue.id, 'venue_rejected', 'an index price must be above zero');
    this.indexes.set(symbol, price);
    this.samplePrices(symbol);
  }

  /** TEST control: whether the venue publishes the perpetual's index now (J-derivatives-08 #6). Unpublished, no sample is kept. */
  setIndexPublished(symbol: string, published: boolean): void {
    const market = this.market(symbol);
    if (market.kind !== 'perpetual') refuse(this.venue.id, 'not_offered', `${symbol} is cash spot: it has no index`);
    if (published) this.indexUnpublished.delete(symbol);
    else this.indexUnpublished.add(symbol);
    this.samplePrices(symbol);
  }

  /**
   * TEST control: whether the venue publishes funding on a perpetual that settles it now (J-derivatives-08 #2). While it
   * publishes none, the market reads `funding: known: false` and a period it closes books nothing.
   */
  setFundingPublished(symbol: string, published: boolean): void {
    this.fundingStateOf(this.settlingMarket(symbol)).published = published;
  }

  /**
   * TEST control: the venue closes the perpetual's current funding period now (J-derivatives-08 #3 #4), early on its own
   * clock, and the next period starts. With a published rate it books one payment per open position, as the field note
   * on `SimMarketConfig.funding` says, and keeps the period in its funding history; with none it books nothing.
   */
  settleFunding(symbol: string): { periodAt: Date; rate: Amount | null; payments: number } {
    const market = this.settlingMarket(symbol);
    const funding = market.funding!;
    const state = this.fundingStateOf(market);
    const periodAt = new Date(this.nextFundingAt(market));
    state.nextAt = periodAt.getTime() + funding.intervalSeconds * 1000;
    if (!state.published) return { periodAt, rate: null, payments: 0 };
    const { rate, inputs } = this.builtRate(market);
    const mark = inputs.markPrice;
    let payments = 0;
    for (const account of this.accounts.values()) {
      const p = account.positions.get(symbol);
      if (!p || p.size === ZERO) continue;
      const owed = truncate(mul(mul(p.size, mark), rate), 12);
      // A positive rate: longs pay shorts. A negative one: shorts pay longs.
      const amount = p.side === 'long' ? sub(ZERO, owed) : owed;
      p.margin = add(p.margin, amount);
      const balance = this.lockBalance(
        account,
        market.marginAccount?.name ?? null,
        market.marginAccount?.collateralAsset ?? market.quoteAsset,
      );
      balance.locked = add(balance.locked, amount);
      account.fundingPayments.push({
        paymentId: `fund-${++this.fundingCounter}`,
        symbol,
        side: p.side,
        size: p.size,
        markPrice: mark,
        rate,
        amount,
        asset: market.marginAccount?.collateralAsset ?? market.quoteAsset,
        periodAt,
      });
      payments += 1;
    }
    state.settled.push({ fundingAt: periodAt, rate, premium: inputs.premium });
    return { periodAt, rate, payments };
  }

  /** The funding the venue booked on the account's positions since `since`, oldest first (J-derivatives-08 #3 #4 #5). */
  async fundingPayments(account: UserVenueAccount, since: Date): Promise<AsOf<readonly UserVenueFundingPayment[]>> {
    this.up();
    const state = this.account(account);
    return this.asOf(state.fundingPayments.filter((f) => f.periodAt.getTime() >= since.getTime()));
  }

  /**
   * The perpetual's mark or index as the venue published it since `since`, oldest first (J-derivatives-08 #6); an index
   * the venue does not publish now answers `known: false` with its reason.
   */
  async priceHistory(
    symbol: string,
    kind: 'mark' | 'index',
    since: Date,
  ): Promise<AsOf<{ known: true; value: readonly VenuePriceSample[] } | { known: false; reason: string }>> {
    this.up();
    const market = this.market(symbol);
    if (market.kind !== 'perpetual') refuse(this.venue.id, 'not_offered', `${symbol} is cash spot: it has no ${kind} price`);
    if (kind === 'index' && this.indexUnpublished.has(symbol))
      return this.asOf({ known: false, reason: `${this.venue.displayName} publishes no index for ${symbol}` });
    const samples = this.priceSamples.get(symbol)?.[kind] ?? [];
    return this.asOf({ known: true, value: samples.filter((x) => x.sampledAt.getTime() >= since.getTime()) });
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
  settleWithdrawal(account: UserVenueAccount, nonce: string, outcome: 'done' | 'failed', txHash?: string): boolean {
    const state = this.account(account);
    const withdrawal = state.withdrawals.get(nonce);
    if (!withdrawal || withdrawal.status !== 'pending') return false;
    if (outcome === 'failed') {
      const balance = this.balance(state, withdrawal.asset);
      balance.free = add(balance.free, add(withdrawal.amount, this.withdrawalFeeCharged.get(`${state.key}#${nonce}`) ?? ZERO));
    }
    // The chain transaction that paid it, when a chain payer settled it (chain-deposits.ts); a TEST settle names none.
    state.withdrawals.set(nonce, {
      ...withdrawal,
      status: outcome,
      ...(outcome === 'done' && txHash ? { txHash: txHash.toLowerCase() } : {}),
    });
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
      minOrderNotional: this.marketState.get(m.symbol)!.minOrderNotional,
      priceBandBps: this.marketState.get(m.symbol)!.priceBandBps,
      maxOpenOrders: this.marketState.get(m.symbol)!.maxOpenOrders,
      builderFeeCapBps: m.builderFeeCapBps ?? { known: false },
      listedBy: published(m.listedBy),
      oracleRule: published(m.oracleRule),
      markRule: published(m.markRule),
      tradingHours: published(m.tradingHours),
      feed: m.oracle ? { known: true, value: this.feedOf(m) } : { known: false },
      session: m.session ? { known: true, value: this.sessionOf(m) } : { known: false },
      marginAccount: published(m.marginAccount),
      lastEvent: published(this.marketEvents.get(m.symbol)),
      openInterest: this.openInterestCaps.has(m.symbol)
        ? { known: true, value: { size: this.openInterestOf(m.symbol), capSize: this.openInterestCaps.get(m.symbol) ?? null } }
        : { known: false },
      contractSize: published(m.contractSize),
      mark: published(m.kind === 'perpetual' ? this.marks.get(m.symbol) : undefined),
      funding: this.publishedFunding(m),
      triggerSources: m.kind === 'perpetual' ? (m.triggerSources ?? []) : [],
      index: published(m.kind === 'perpetual' && !this.indexUnpublished.has(m.symbol) ? this.indexes.get(m.symbol) : undefined),
      // The simulator's own rule (`place`): an order that would cross this account's own resting order cancels the resting one.
      selfTrade: { known: true, value: 'cancel_resting' },
      marginTiers: published(m.kind === 'perpetual' ? m.marginTiers : undefined),
      collateral: published(m.collateral),
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

  /**
   * The funding the venue published on the perpetual `symbol` at each whole interval since `since`, oldest first
   * (J-charts-desk-04 #6). TEST: the simulator's history is its configured rate at every settled interval of the last
   * `FUNDING_HISTORY_MS` on its own clock (it settles none), capped at `FUNDING_HISTORY_ROWS` rows.
   */
  async fundingHistory(symbol: string, since: Date): Promise<AsOf<readonly VenueFundingRow[]>> {
    this.up();
    const market = this.market(symbol);
    if (market.kind !== 'perpetual' || !market.funding) refuse(this.venue.id, 'not_offered', `${symbol} publishes no funding`);
    // A market that settles its funding (J-derivatives-08 #6): the periods it closed with a rate, as it recorded them.
    if (market.funding.settles)
      return this.asOf(
        this.fundingStateOf(market)
          .settled.filter((r) => r.fundingAt.getTime() >= since.getTime())
          .slice(-FUNDING_HISTORY_ROWS),
      );
    const step = market.funding.intervalSeconds * 1000;
    const now = this.clock().getTime();
    const from = Math.max(since.getTime(), now - FUNDING_HISTORY_MS);
    const rows: VenueFundingRow[] = [];
    for (let t = Math.ceil(from / step) * step; t <= now && rows.length < FUNDING_HISTORY_ROWS; t += step)
      rows.push({ fundingAt: new Date(t), rate: market.funding.rate });
    return this.asOf(rows);
  }

  /** The newest `limit` public prints on `symbol`, newest first: every account's fills, one print per match. */
  async trades(symbol: string, limit: number): Promise<AsOf<readonly VenuePrint[]>> {
    this.up();
    const market = this.market(symbol);
    const kept = this.prints.get(market.symbol) ?? [];
    return this.asOf(kept.slice(-Math.min(limit, MARKET_READ_MAX)).reverse());
  }

  /**
   * The newest `limit` candles of `symbol`'s prints on `interval`, oldest first; an interval with no print is not sent.
   * TEST: only the prints the simulator keeps (`PRINTS_KEPT`) are counted.
   */
  async candles(symbol: string, interval: VenueCandleInterval, limit: number): Promise<AsOf<readonly VenueCandle[]>> {
    this.up();
    const market = this.market(symbol);
    const stepMs = VENUE_CANDLE_INTERVALS[interval] * 1000;
    const out: VenueCandle[] = [];
    for (const p of this.prints.get(market.symbol) ?? []) {
      const openMs = Math.floor(p.tradedAt.getTime() / stepMs) * stepMs;
      const last = out[out.length - 1];
      if (last && last.openAt.getTime() === openMs)
        out[out.length - 1] = {
          ...last,
          highPrice: max(last.highPrice, p.price),
          lowPrice: min(last.lowPrice, p.price),
          closePrice: p.price,
          baseVolume: add(last.baseVolume, p.amount),
        };
      else
        out.push({
          openAt: new Date(openMs),
          openPrice: p.price,
          highPrice: p.price,
          lowPrice: p.price,
          closePrice: p.price,
          baseVolume: p.amount,
        });
    }
    return this.asOf(out.slice(-Math.min(limit, MARKET_READ_MAX)));
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
    const { lockAsset, lockAmount } = this.orderLock(market, intent, setting, builderFee, state);

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
    const rates = this.ratesOf(state, market);
    const venueFee = line((r) => (r === 'maker' ? rates.makerFeeBps : rates.takerFeeBps));
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
      rates,
      fill,
      perpetual,
    });
  }

  // ── UserVenue: signed actions ──────────────────────────────────────────

  async prepare(account: UserVenueAccount, signer: VenueSigner, intent: VenueIntent): Promise<PreparedVenueAction> {
    this.up();
    this.validate(account, signer, intent);
    const cloid =
      intent.kind === 'place_order' || intent.kind === 'cancel_order'
        ? venueClientOrderId(this.venue.id, intent.clientOrderKey)
        : intent.kind === 'replace_order'
          ? venueClientOrderId(this.venue.id, intent.order.clientOrderKey)
          : intent.kind === 'amend_order'
            ? intent.venueClientOrderId
            : null;
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
    this.refuseDuringLiquidation(state, intent);
    switch (intent.kind) {
      case 'place_orders': {
        const most = ordersTakenTogether(this.venue);
        if (most < 2)
          refuse(this.venue.id, 'not_offered', `${this.venue.displayName} takes one order per signature: sign each order on its own`);
        if (!Array.isArray(intent.orders) || intent.orders.length < 2)
          refuse(this.venue.id, 'venue_rejected', 'orders signed together are at least two');
        if (intent.orders.length > most)
          refuse(this.venue.id, 'not_offered', `${this.venue.displayName} takes at most ${most} orders in one signed action`);
        const keys = new Set(intent.orders.map((o) => o.clientOrderKey));
        if (keys.size !== intent.orders.length)
          refuse(this.venue.id, 'venue_rejected', 'each order signed together has its own client order key');
        for (const order of intent.orders) {
          if (order?.kind !== 'place_order') refuse(this.venue.id, 'venue_rejected', 'only orders are signed together');
          // A trigger order rests unseen; one attached to an entry is armed by that entry: neither is sent in a batch here.
          if (order.trigger || order.parentClientOrderKey) refuse(this.venue.id, 'not_offered', 'a trigger order is signed on its own');
          // Each order's own checks, so the wallet is never asked to sign an order that must fail on its face.
          this.validate(account, signer, order);
        }
        return;
      }
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
      case 'update_isolated_margin': {
        const market = this.market(intent.symbol);
        if (market.kind !== 'perpetual') refuse(this.venue.id, 'not_offered', `${intent.symbol} is spot: it has no position margin`);
        const position = this.openIsolated(state, intent.symbol);
        // A removal below the venue's limit is refused before the wallet is asked to sign it, and again at submit.
        if (intent.direction === 'remove') this.checkRemovable(position, intent.amount);
        return;
      }
      case 'withdraw':
        if (compare(intent.amount, ZERO) <= 0) refuse(this.venue.id, 'venue_rejected', 'a withdrawal must be positive');
        if (account.subAccount !== null) {
          refuse(this.venue.id, 'not_offered', 'a withdrawal from a sub-account is not offered: move the funds to the main account first');
        }
        return;
      case 'approve_builder_fee':
        if (compare(intent.maxFeeBps, ZERO) < 0) refuse(this.venue.id, 'venue_rejected', 'a builder fee approval cannot be negative');
        return;
      case 'amend_order': {
        if (!this.venue.amendsInPlace)
          refuse(this.venue.id, 'not_offered', `${this.venue.displayName} does not amend in place: cancel and replace the order`);
        const resting = this.restingOrder(state, intent.symbol, intent.venueClientOrderId);
        if (compare(intent.price, resting.order.price) !== 0)
          refuse(this.venue.id, 'not_offered', 'a new price is not an amend in place: cancel and replace the order');
        if (compare(intent.amount, ZERO) <= 0) refuse(this.venue.id, 'venue_rejected', 'the amount left must be positive');
        if (compare(intent.amount, resting.order.remaining) >= 0)
          refuse(this.venue.id, 'not_offered', `${this.venue.displayName} amends in place only to lower the amount left`);
        this.checkOrderOnItsFace(state, {
          kind: 'place_order',
          symbol: intent.symbol,
          side: resting.order.side,
          type: resting.order.type,
          amount: intent.amount,
          price: intent.price,
          timeInForce: resting.order.timeInForce,
          reduceOnly: resting.order.reduceOnly,
          clientOrderKey: 'amend:check',
          builderFee: null,
        });
        return;
      }
      case 'replace_order': {
        if (intent.order?.kind !== 'place_order') refuse(this.venue.id, 'venue_rejected', 'a replacement is an order');
        if (intent.order.symbol !== intent.symbol)
          refuse(this.venue.id, 'venue_rejected', 'the replacement is on the market of the order it replaces');
        if (intent.order.trigger || intent.order.parentClientOrderKey)
          refuse(this.venue.id, 'not_offered', 'a trigger order is not placed as a replacement');
        if (venueClientOrderId(this.venue.id, intent.order.clientOrderKey) === intent.venueClientOrderId)
          refuse(this.venue.id, 'venue_rejected', 'the replacement has a client id of its own');
        this.market(intent.symbol);
        this.validate(account, signer, intent.order);
        return;
      }
      case 'cancel_orders': {
        const most = cancelsTakenTogether(this.venue);
        if (most < 1) refuse(this.venue.id, 'not_offered', `${this.venue.displayName} cancels one order per signature`);
        if (!Array.isArray(intent.orders) || intent.orders.length < 1)
          refuse(this.venue.id, 'venue_rejected', 'a batch cancel names at least one order');
        if (intent.orders.length > most)
          refuse(this.venue.id, 'not_offered', `${this.venue.displayName} cancels at most ${most} orders in one signed action`);
        const ids = new Set(intent.orders.map((o) => o?.venueClientOrderId));
        if (ids.size !== intent.orders.length) refuse(this.venue.id, 'venue_rejected', 'each order in a batch cancel is named once');
        for (const o of intent.orders) {
          if (typeof o?.venueClientOrderId !== 'string' || o.venueClientOrderId === '')
            refuse(this.venue.id, 'venue_rejected', 'each order in a batch cancel is named by its client id');
          this.market(o.symbol);
        }
        return;
      }
      case 'cancel_order':
        this.market(intent.symbol);
        venueClientOrderId(this.venue.id, intent.clientOrderKey); // refuses a key that is not a business key
        return;
      case 'schedule_cancel': {
        const offered = this.venue.scheduledCancel;
        if (!offered) refuse(this.venue.id, 'not_offered', `${this.venue.displayName} offers no scheduled cancel`);
        if (!Number.isSafeInteger(intent.timeoutSec) || intent.timeoutSec < 0)
          refuse(this.venue.id, 'venue_rejected', 'a scheduled cancel names its timeout in whole seconds');
        if (intent.time === null) {
          if (intent.timeoutSec !== 0) refuse(this.venue.id, 'venue_rejected', 'removing a scheduled cancel has timeout 0');
          return;
        }
        const at = new Date(intent.time);
        if (typeof intent.time !== 'string' || Number.isNaN(at.getTime()))
          refuse(this.venue.id, 'venue_rejected', 'a scheduled cancel names its time');
        const lead = at.getTime() - this.clock().getTime();
        if (lead < offered.minLeadMs)
          refuse(
            this.venue.id,
            'venue_rejected',
            `a scheduled cancel must be at least ${offered.minLeadMs / 1000} seconds ahead; this one is ${Math.max(0, Math.floor(lead / 1000))}`,
          );
        return;
      }
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
      case 'market_margin_transfer': {
        const rule = this.marginAccountOf(intent.symbol);
        if (intent.asset !== rule.collateralAsset)
          refuse(this.venue.id, 'venue_rejected', `${rule.name} takes ${rule.collateralAsset} only, as its deployer set it`);
        if (compare(intent.amount, ZERO) <= 0) refuse(this.venue.id, 'venue_rejected', 'a margin transfer must be positive');
        return;
      }
    }
  }

  /** The deployer's own margin account a market keeps, or `not_offered` for a market whose orders use the main account. */
  private marginAccountOf(symbol: string): UserVenueMarginAccountRule {
    const market = this.market(symbol);
    if (!market.marginAccount)
      refuse(
        this.venue.id,
        'not_offered',
        `${symbol} has no margin account of its own on ${this.venue.displayName}: it uses the main account`,
      );
    return market.marginAccount;
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
    // A fill moves the mark and the last price: any trigger order they now cross fires before the answer goes back.
    this.runTriggers();
    this.assertNoNegativeBalance();
    const placedKeys =
      prepared.intent.kind === 'place_order'
        ? outcome.definite && outcome.accepted
          ? [prepared.intent.clientOrderKey]
          : []
        : prepared.intent.kind === 'place_orders' && outcome.definite && outcome.accepted
          ? prepared.intent.orders.filter((_, i) => outcome.legs?.[i]?.accepted).map((o) => o.clientOrderKey)
          : prepared.intent.kind === 'replace_order' && outcome.definite && outcome.accepted && outcome.legs?.[1]?.accepted
            ? [prepared.intent.order.clientOrderKey]
            : [];
    if (placedKeys.length > 0 && recovered) {
      const signers = this.orderSigners.get(key) ?? new Map<string, VenueSigner>();
      this.orderSigners.set(key, signers);
      for (const clientOrderKey of placedKeys) {
        const cloid = venueClientOrderId(this.venue.id, clientOrderKey);
        if (!signers.has(cloid)) signers.set(cloid, { role: prepared.signer.role, address: recovered });
      }
    }
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
    const assets = new Set([...state.balances.keys(), ...state.deficits.keys()]);
    const list = [...assets]
      .sort((a, b) => a.localeCompare(b))
      .map((asset) => {
        const b = state.balances.get(asset) ?? { free: ZERO, locked: ZERO };
        const free = sub(b.free, state.deficits.get(asset) ?? ZERO);
        const lockedBy = this.lockSplit(state, asset, b.locked);
        return { asset, free, locked: b.locked, total: add(free, b.locked), ...(lockedBy ? { lockedBy } : {}) };
      });
    return this.asOf(list);
  }

  /**
   * What holds an asset's locked figure on the main balances (J-portfolio-01 #4): the resting orders' locks, the posted
   * margin of the positions margined in it, and its stake. Orders and positions in a deployer's own margin account lock
   * there, not here. When the three do not add to the locked figure exactly, the venue reports no split (null).
   */
  private lockSplit(state: AccountState, asset: string, locked: Amount): UserVenueLockSplit | null {
    let inOrders = ZERO;
    for (const o of state.orders.values())
      if ((o.order.status === 'open' || o.order.status === 'partially_filled') && o.marginAccount === null && o.order.lockedAsset === asset)
        inOrders = add(inOrders, o.order.locked);
    let margin = ZERO;
    for (const [symbol, p] of state.positions) {
      if (p.size === ZERO) continue;
      const market = this.market(symbol);
      if (!market.marginAccount && market.quoteAsset === asset) margin = add(margin, p.margin);
    }
    const staked = state.stakes.get(asset) ?? ZERO;
    return compare(add(add(inOrders, margin), staked), locked) === 0 ? { inOrders, margin, staked } : null;
  }

  /**
   * TEST only (J-portfolio-01 #4): stake `amount` of `asset` on the venue, from free into locked, once per `stakeRef`.
   * A stand-in for a venue's own staking, which no venue adapter reaches yet; refuses a stake larger than free.
   */
  testStake(account: UserVenueAccount, asset: string, amount: Amount, stakeRef: string): boolean {
    this.up();
    const state = this.account(account);
    if (state.stakeRefs.has(stakeRef)) return false;
    const balance = state.balances.get(asset);
    if (compare(amount, ZERO) <= 0) throw new VenueWireError('stake amount must be above zero');
    if (!balance || compare(balance.free, amount) < 0)
      throw new VenueWireError(`stake of ${formatAmount(amount)} ${asset} is more than free`);
    balance.free = sub(balance.free, amount);
    balance.locked = add(balance.locked, amount);
    state.stakes.set(asset, add(state.stakes.get(asset) ?? ZERO, amount));
    state.stakeRefs.add(stakeRef);
    return true;
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

  /**
   * TEST only: who signed the order this account placed under `cloid`, the address recovered from the signed bytes
   * when the venue accepted it, and whether it signed as the owner or as an agent. `null` when no such order was placed.
   */
  orderSigner(account: UserVenueAccount, cloid: string): AsOf<VenueSigner | null> {
    this.up();
    return this.asOf(this.orderSigners.get(accountKey(account))?.get(cloid) ?? null);
  }

  async orderByClientId(account: UserVenueAccount, cloid: string): Promise<AsOf<UserVenueOrder | null>> {
    this.up();
    return this.asOf(this.account(account).orders.get(cloid)?.order ?? null);
  }

  async orderHistory(account: UserVenueAccount): Promise<AsOf<readonly UserVenueOrderRecord[]>> {
    this.up();
    const list = [...this.account(account).orders.values()]
      .sort((a, b) => b.seq - a.seq)
      .map((o) => ({ order: o.order, placedAt: o.placedAt }));
    return this.asOf(list);
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
        maintenanceMargin: this.maintenanceOf(market, p),
      });
    }
    return this.asOf(list);
  }

  /** The TEST venue's published withdrawal terms for `asset` (J-bank-31 #3), as its switches set them. */
  async withdrawalTerms(asset: string): Promise<AsOf<UserVenueWithdrawalTerms>> {
    this.up();
    return this.asOf({
      asset,
      fee: this.switches.withdrawalFee,
      networkFee: this.switches.networkFee,
      arrivalSeconds: this.switches.withdrawalArrivalSeconds,
    });
  }

  async withdrawal(account: UserVenueAccount, nonce: string): Promise<AsOf<UserVenueWithdrawal | null>> {
    this.up();
    return this.asOf(this.account(account).withdrawals.get(nonce) ?? null);
  }

  /**
   * The published fee tiers, and with an account its tier, the volume the venue counted for it and the rates it charges
   * it now (J-cex-spot-10 #2 #6). The tier is the one the venue's last update placed the account in
   * (`updateFeeTier`), never recomputed on a read.
   */
  async feeStatus(account: UserVenueAccount | null): Promise<AsOf<VenueFeeStatus>> {
    this.up();
    const otherFees = this.switches.otherFeesUnpublished ? null : this.otherFees();
    if (account === null) return this.asOf({ schedule: this.feeSchedule, account: null, otherFees });
    const state = this.account(account);
    const tiers = this.feeSchedule.tiers;
    const tier = tiers ? tiers[state.feeTier?.index ?? 0] : undefined;
    const rates = (kind: 'spot' | 'perpetual'): VenueFeeRates => (tier && (state.feeTier?.index ?? 0) > 0 ? tier[kind] : NO_RATES);
    return this.asOf({
      schedule: this.feeSchedule,
      account: {
        tierName: tier?.name ?? null,
        volume: state.feeTier ? { known: true, value: state.feeTier.volume } : { known: false },
        // The base tier charges each market's own published rates (`ratesOf`), so the account has no one rate there.
        spot: rates('spot'),
        perpetual: rates('perpetual'),
        tierUpdatedAt: state.feeTier?.updatedAt ?? null,
      },
      otherFees,
    });
  }

  /**
   * The fees the TEST venue charges beside its trading fees (J-derivatives-12 #2), as it charges them: nothing when it
   * settles positions at a market event (a deployer's halt or a split settles at the price alone), and on each market it
   * liquidates on, its liquidation fee (`liquidatePart`) in that market's published words.
   */
  private otherFees(): VenueOtherFee[] {
    const fees: VenueOtherFee[] = [
      {
        kind: 'settlement',
        name: 'TEST settlement fee',
        symbol: null,
        feeBps: ZERO,
        rule: 'TEST rule: no fee is charged when the venue settles positions at a market event (a deployer’s halt or a split).',
      },
    ];
    for (const m of this.marketsBySymbol.values())
      if (m.kind === 'perpetual' && m.liquidation)
        fees.push({
          kind: 'liquidation',
          name: 'TEST liquidation fee',
          symbol: m.symbol,
          feeBps: mul(m.liquidation.feeRate, parseAmount('10000')),
          rule: m.liquidation.feeRule,
        });
    return fees;
  }

  /** TEST control: the venue's published fee tiers. Each starts above the last; the first starts at zero. */
  setFeeSchedule(schedule: VenueFeeTiers): void {
    const tiers = schedule.tiers;
    if (tiers) {
      if (tiers.length === 0 || tiers[0]!.fromVolume !== ZERO) throw new Error('TEST fee tiers start with a tier from zero');
      for (let i = 1; i < tiers.length; i++)
        if (compare(tiers[i]!.fromVolume, tiers[i - 1]!.fromVolume) <= 0) throw new Error('TEST fee tiers rise in volume');
      for (const t of tiers)
        for (const r of [t.spot, t.perpetual])
          if (r.takerFeeBps.known && compare(r.takerFeeBps.value, ZERO) < 0) throw new Error('a taker rate is never below zero');
    }
    this.feeSchedule = schedule;
  }

  /**
   * TEST control: the venue's next update of one owner's fee tier (J-cex-spot-10 #6), as Hyperliquid updates tiers once a
   * day. It counts the notional of the main account's fills over the schedule's days and places the account in the
   * highest tier that volume reaches. Only the named owner moves, so no other account's rates change under it.
   */
  updateFeeTier(owner: string): { index: number; volume: Amount; updatedAt: Date } {
    const state = this.account({ venueId: this.venue.id, owner, subAccount: null });
    const since = this.clock().getTime() - this.feeSchedule.volumeDays * 86_400_000;
    let volume = ZERO;
    for (const f of state.fills) if (f.filledAt.getTime() >= since) volume = add(volume, mul(f.price, f.amount, QUOTE_ROUND));
    let index = 0;
    for (const [i, t] of (this.feeSchedule.tiers ?? []).entries()) if (compare(volume, t.fromVolume) >= 0) index = i;
    state.feeTier = { index, volume, updatedAt: this.clock() };
    return state.feeTier;
  }

  /**
   * The rates this account pays on `market`: its tier's when the venue placed it above the base tier, else the market's
   * own published rates (the base tier). A rate the tier leaves unpublished falls back to the market's.
   */
  private ratesOf(state: AccountState | null, market: SimMarketConfig): VenueFeeRates {
    const own = { makerFeeBps: market.makerFeeBps, takerFeeBps: market.takerFeeBps };
    const index = state?.feeTier?.index ?? 0;
    const tier = index > 0 ? this.feeSchedule.tiers?.[index] : undefined;
    if (!tier) return own;
    const r = tier[market.kind === 'perpetual' ? 'perpetual' : 'spot'];
    return {
      makerFeeBps: r.makerFeeBps.known ? r.makerFeeBps : own.makerFeeBps,
      takerFeeBps: r.takerFeeBps.known ? r.takerFeeBps : own.takerFeeBps,
    };
  }

  async builderFeeApproval(account: UserVenueAccount, builder: string): Promise<AsOf<Amount>> {
    this.up();
    return this.asOf(this.account(account).builderApprovals.get(builder.toLowerCase()) ?? ZERO);
  }

  /**
   * The TEST venue's own builder-fee totals for `builder` (OWNER 288 1e): every builder fee it charged on a fill that
   * carried that builder, per fee asset, and what of it the builder has not claimed (`claimBuilderFees`). The
   * `builderTotalsUnknown` switch answers not known.
   */
  async builderTotals(builder: string): Promise<AsOf<MaybeKnown<VenueBuilderTotals>>> {
    this.up();
    if (this.switches.builderTotalsUnknown) return this.asOf({ known: false });
    const b = builder.toLowerCase();
    const assets = [...(this.builderEarned.get(b) ?? new Map<string, Amount>()).entries()]
      .sort(([x], [y]) => x.localeCompare(y))
      .map(([asset, earned]) => ({ asset, earned, unclaimed: sub(earned, this.builderClaimed(b, asset)) }));
    return this.asOf({ known: true, value: { builder: b, assets } });
  }

  /** Every builder fee claim the TEST venue records for `builder`, oldest first. */
  async builderClaims(builder: string): Promise<AsOf<readonly UserVenueBuilderClaim[]>> {
    this.up();
    return this.asOf([...(this.builderClaimRecord.get(builder.toLowerCase()) ?? [])]);
  }

  /**
   * TEST control: `builder` claims every builder fee it has not claimed yet, one claim per fee asset, paid into the
   * builder's own main account at this venue (free to withdraw). Returns the claims it made; nothing unclaimed makes
   * none. Never part of `UserVenue`.
   */
  claimBuilderFees(builder: string): readonly UserVenueBuilderClaim[] {
    this.up();
    const b = builder.toLowerCase();
    if (!/^0x[0-9a-f]{40}$/.test(b)) refuse(this.venue.id, 'venue_rejected', 'builder must be a 0x address');
    const made: UserVenueBuilderClaim[] = [];
    const record = this.builderClaimRecord.get(b) ?? [];
    for (const [asset, earned] of [...(this.builderEarned.get(b) ?? new Map<string, Amount>()).entries()].sort(([x], [y]) =>
      x.localeCompare(y),
    )) {
      const unclaimed = sub(earned, this.builderClaimed(b, asset));
      if (compare(unclaimed, ZERO) <= 0) continue;
      this.builderClaimCounter += 1;
      const claim = {
        claimId: `sim-builder-claim-${this.builderClaimCounter}`,
        builder: b,
        asset,
        amount: unclaimed,
        claimedAt: this.clock(),
      };
      const balance = this.balance(this.account({ venueId: this.venue.id, owner: b, subAccount: null }), asset);
      balance.free = add(balance.free, unclaimed);
      record.push(claim);
      made.push(claim);
    }
    this.builderClaimRecord.set(b, record);
    return made;
  }

  private builderClaimed(builder: string, asset: string): Amount {
    return (this.builderClaimRecord.get(builder) ?? []).filter((c) => c.asset === asset).reduce((n, c) => add(n, c.amount), ZERO);
  }

  async leverage(account: UserVenueAccount, symbol: string): Promise<AsOf<UserVenueLeverage | null>> {
    this.up();
    this.market(symbol);
    const setting = this.account(account).leverage.get(symbol);
    return this.asOf(setting ? { symbol, ...setting } : null);
  }

  /** What `update_leverage` would do to the open position on `symbol`, by the same rule its submit applies (J-derivatives-05 #4). */
  async leverageChange(
    account: UserVenueAccount,
    symbol: string,
    leverageBps: number,
    marginMode: VenueMarginMode,
  ): Promise<AsOf<UserVenueLeverageChange>> {
    this.up();
    const market = this.checkLeverageOnItsFace(symbol, leverageBps, marginMode);
    const p = this.account(account).positions.get(symbol);
    const open = p && p.size !== ZERO ? p : null;
    const marginNow = open ? open.margin : ZERO;
    const marginAfter = open ? this.marginAt(open, leverageBps) : ZERO;
    return this.asOf({
      symbol,
      leverageBps,
      marginMode,
      maxLeverageBps: market.maxLeverageBps,
      positionSize: open ? open.size : ZERO,
      marginNow,
      marginAfter,
      difference: sub(marginAfter, marginNow),
    });
  }

  /** The open isolated position's margin on `symbol` and the TEST venue's removal limit (J-derivatives-06 #2 #3). */
  async isolatedMargin(account: UserVenueAccount, symbol: string): Promise<AsOf<UserVenueIsolatedMargin>> {
    this.up();
    const market = this.market(symbol);
    if (market.kind !== 'perpetual') refuse(this.venue.id, 'not_offered', `${symbol} is spot: it has no position margin`);
    const state = this.account(account);
    const p = this.openIsolated(state, symbol);
    const asset = market.marginAccount?.collateralAsset ?? market.quoteAsset;
    const usdc = this.lockBalance(state, market.marginAccount?.name ?? null, asset);
    const floor = this.marginAt(p, p.leverageBps);
    return this.asOf({
      symbol,
      side: p.side,
      size: p.size,
      margin: p.margin,
      minimumMargin: floor,
      removable: max(ZERO, sub(p.margin, floor)),
      free: usdc.free,
      asset,
      liquidationPrice: this.liquidationPrice(market, p),
      rule: `TEST rule: margin may be removed down to the position's entry value at its leverage (${p.leverageBps / 10_000}x)`,
    });
  }

  /**
   * The account's margin summary in its perpetual collateral (J-derivatives-06 #1): equity is every unit of collateral it
   * holds, free and locked, plus each position's unrealised result at the mark; used margin is the positions' margin.
   */
  async accountSummary(account: UserVenueAccount): Promise<AsOf<UserVenueAccountSummary>> {
    this.up();
    const state = this.account(account);
    const perps = [...this.marketsBySymbol.values()].filter((m) => m.kind === 'perpetual' && !m.marginAccount);
    const asset = perps[0]?.quoteAsset ?? 'USDC';
    const b = this.balance(state, asset);
    let unrealised = ZERO;
    let used = ZERO;
    let maintenance = ZERO;
    for (const [symbol, p] of state.positions) {
      if (p.size === ZERO) continue;
      const market = this.market(symbol);
      if (market.marginAccount || market.quoteAsset !== asset) continue;
      unrealised = add(unrealised, this.pnl(p, this.marks.get(symbol) ?? p.entryPrice, p.size));
      used = add(used, p.margin);
      const m = this.maintenanceOf(market, p);
      if (m.known) maintenance = add(maintenance, m.value);
    }
    const equity = add(add(b.free, b.locked), unrealised);
    return this.asOf({
      asset,
      equity,
      free: b.free,
      usedMargin: used,
      maintenanceMargin: maintenance,
      marginRatio: compare(equity, ZERO) > 0 ? { known: true, value: div(maintenance, equity, 'ceil') } : { known: false },
    });
  }

  // ── liquidation and its aftermath (J-derivatives-07) ─────────────────────────────────────────────────────────────

  /** The position's liquidation state on `symbol` and the venue's rules for it. A market it liquidates nothing on refuses. */
  async liquidationStatus(account: UserVenueAccount, symbol: string): Promise<AsOf<UserVenueLiquidationStatus>> {
    this.up();
    const rules = this.liquidationRules(symbol);
    const latest =
      this.account(account)
        .liquidations.filter((l) => l.symbol === symbol)
        .at(-1) ?? null;
    return this.asOf({
      symbol,
      state: latest ? latest.state : 'none',
      liquidationId: latest ? latest.liquidationId : null,
      priceRule: rules.priceRule,
      feeRule: rules.feeRule,
    });
  }

  /** The account's liquidations started since `since`, oldest first, each with every part the venue closed. */
  async liquidations(account: UserVenueAccount, since: Date): Promise<AsOf<readonly UserVenueLiquidation[]>> {
    this.up();
    return this.asOf(
      this.account(account)
        .liquidations.filter((l) => l.startedAt.getTime() >= since.getTime())
        .map((l) => ({ ...l, parts: [...l.parts] })),
    );
  }

  /** The TEST insurance fund, or not published (`/test/insurance-fund`). */
  async insuranceFund(): Promise<AsOf<MaybeKnown<UserVenueInsuranceFund>>> {
    this.up();
    if (!this.insurance.published) return this.asOf({ known: false });
    return this.asOf({
      known: true,
      value: {
        name: 'TEST venue insurance fund',
        asset: 'USDC',
        balance: this.insurance.balance,
        whereToRead: `On ${this.venue.displayName} itself: its insurance fund read (POST /insurance-fund) shows the same balance.`,
        rule:
          'TEST rule: every liquidation fee is paid into the fund, and the fund pays any loss a liquidation leaves beyond ' +
          "the position's margin, up to what it holds.",
      },
    });
  }

  /** The TEST auto-deleveraging rules and their version, or `null` while the venue publishes none (`/test/adl-rules`). */
  async adlRules(): Promise<AsOf<UserVenueAdlRules | null>> {
    this.up();
    return this.asOf(this.adl);
  }

  /** The account's auto-deleveragings since `since`, oldest first. */
  async deleverages(account: UserVenueAccount, since: Date): Promise<AsOf<readonly UserVenueDeleverage[]>> {
    this.up();
    return this.asOf(this.account(account).deleverages.filter((d) => d.deleveragedAt.getTime() >= since.getTime()));
  }

  /** The newest `limit` public alerts, newest first, on `symbol` or every market; no account in them. */
  async liquidationAlerts(symbol: string | null, limit: number): Promise<AsOf<readonly VenueLiquidationAlert[]>> {
    this.up();
    if (symbol !== null) this.market(symbol);
    const n = Math.max(1, Math.min(limit, ALERTS_KEPT));
    return this.asOf(
      this.alerts
        .filter((a) => symbol === null || a.symbol === symbol)
        .slice(-n)
        .reverse(),
    );
  }

  /** TEST control: the venue publishes its insurance fund, or publishes none (it still runs it). */
  setInsuranceFundPublished(published: boolean): void {
    this.insurance.published = published;
  }

  /** TEST control: the auto-deleveraging rules the venue publishes now (a new version), or none. */
  setAdlRules(rules: UserVenueAdlRules | null): void {
    if (rules && (rules.version.trim() === '' || rules.text.trim() === ''))
      refuse(this.venue.id, 'venue_rejected', 'auto-deleveraging rules need a version and their words');
    this.adl = rules;
  }

  /**
   * TEST control: the venue's auto-deleveraging closes the account's whole position on `symbol` at `price` (the bankruptcy
   * price of a liquidated position on the other side the insurance fund did not cover), with no fee, cancels its orders
   * there, and sends the account its notice. The simulator does not choose whom to deleverage: the journey names the account.
   */
  deleverage(account: UserVenueAccount, symbol: string, price: Amount): UserVenueDeleverage {
    const market = this.market(symbol);
    this.liquidationRules(symbol);
    if (compare(price, ZERO) <= 0) refuse(this.venue.id, 'venue_rejected', 'a deleveraging price must be above zero');
    const state = this.account(account);
    const p = state.positions.get(symbol);
    if (!p || p.size === ZERO) refuse(this.venue.id, 'venue_rejected', `no open position on ${symbol} to deleverage`);
    this.cancelAllOn(state, symbol);
    const usdc = this.lockBalance(state, market.marginAccount?.name ?? null, market.marginAccount?.collateralAsset ?? market.quoteAsset);
    const size = p.size;
    const realisedPnl = max(this.pnl(p, price, size), sub(ZERO, p.margin));
    usdc.locked = sub(usdc.locked, p.margin);
    usdc.free = add(usdc.free, add(p.margin, realisedPnl));
    p.margin = ZERO;
    p.size = ZERO;
    const at = this.clock();
    const record: UserVenueDeleverage = {
      adlId: `adl-${++this.adlCounter}`,
      symbol,
      side: p.side,
      size,
      price,
      realisedPnl,
      notice:
        `TEST notice: auto-deleveraging closed your ${p.side} of ${formatAmount(size)} ${symbol} at ${formatAmount(price)}, ` +
        'the bankruptcy price of a liquidated position the insurance fund did not cover. No fee was charged.',
      deleveragedAt: at,
    };
    state.deleverages.push(record);
    this.alert({ kind: 'deleverage', symbol, side: p.side, size, price, alertedAt: at });
    return record;
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

  /** The account's settlements in market events since `since`, oldest first (J-derivatives-27 #9 #10). */
  async settlements(account: UserVenueAccount, since: Date): Promise<AsOf<readonly UserVenueSettlement[]>> {
    this.up();
    return this.asOf(this.account(account).settlements.filter((s) => s.settledAt.getTime() >= since.getTime()));
  }

  /** The account's scheduled cancel as the venue records it (J-cex-spot-07); refused where none is offered. */
  async scheduledCancel(account: UserVenueAccount): Promise<AsOf<UserVenueScheduledCancel>> {
    this.up();
    if (!this.venue.scheduledCancel) refuse(this.venue.id, 'not_offered', `${this.venue.displayName} offers no scheduled cancel`);
    const { cancelsAt, lastFired } = this.account(account).scheduled;
    return this.asOf({ cancelsAt, lastFired });
  }

  /** The owner's balance in the margin account `symbol`'s deployer keeps for it, read on the main account. */
  async marketMargin(account: UserVenueAccount, symbol: string): Promise<AsOf<UserVenueMarketMargin>> {
    this.up();
    if (account.subAccount !== null) refuse(this.venue.id, 'not_offered', 'a market margin account is read on the main account');
    const rule = this.marginAccountOf(symbol);
    const b = this.account(account).marketMargins.get(rule.name) ?? { free: ZERO, locked: ZERO };
    return this.asOf({ symbol, ...rule, free: b.free, locked: b.locked, total: add(b.free, b.locked) });
  }

  /** A removal of `amount` from `p`'s margin, refused in words below the venue's limit (its entry value at its leverage). */
  private checkRemovable(p: PositionState, amount: Amount): void {
    const floor = this.marginAt(p, p.leverageBps);
    const removable = max(ZERO, sub(p.margin, floor));
    if (compare(amount, removable) > 0)
      refuse(
        this.venue.id,
        'venue_rejected',
        `removing ${formatAmount(amount)} would leave ${formatAmount(sub(p.margin, amount))} margin, below this venue's minimum of ${formatAmount(floor)} for the position (its entry value at ${p.leverageBps / 10_000}x); at most ${formatAmount(removable)} can be removed`,
      );
  }

  /** The account's open isolated position on `symbol`, or a refusal in words. */
  private openIsolated(state: AccountState, symbol: string): PositionState {
    const p = state.positions.get(symbol);
    if (!p || p.size === ZERO) refuse(this.venue.id, 'venue_rejected', `no position is open on ${symbol}, so it has no margin to change`);
    if (p.marginMode !== 'isolated')
      refuse(
        this.venue.id,
        'venue_rejected',
        `the position on ${symbol} is on cross margin: only an isolated position's margin is changed on its own`,
      );
    return p;
  }

  private mainOnly(account: UserVenueAccount): void {
    if (account.subAccount !== null) refuse(this.venue.id, 'not_offered', 'sub-accounts and transfers are read on the main account');
  }

  // ── internals ──────────────────────────────────────────────────────────

  /** A balance below zero is money the venue made up: fail loudly, never report it. */
  private assertNoNegativeBalance(): void {
    for (const state of this.accounts.values()) {
      for (const [asset, b] of [...state.balances, ...state.marketMargins]) {
        if (compare(b.free, ZERO) < 0 || compare(b.locked, ZERO) < 0) {
          throw new Error(`TEST simulator invariant: ${state.key} ${asset} free ${b.free} locked ${b.locked}`);
        }
      }
    }
  }

  /** The fee a fill is charged: the published one, or the TEST switch's hidden one when it is not published. */
  private chargedFeeBps(market: SimMarketConfig, role: 'maker' | 'taker', state: AccountState | null): Amount {
    const rates = this.ratesOf(state, market);
    const published = role === 'maker' ? rates.makerFeeBps : rates.takerFeeBps;
    if (published.known) return published.value;
    return role === 'maker' ? this.switches.unpublishedMakerFeeBps : this.switches.unpublishedTakerFeeBps;
  }

  private agentLive(state: AccountState, address: string): boolean {
    const agent = state.agents.get(address.toLowerCase());
    return agent !== undefined && (agent.validUntil === null || agent.validUntil.getTime() > this.clock().getTime());
  }

  /**
   * The funding the market publishes now: on a market that settles it, the rate it builds and its inputs, with the next
   * period it closes; otherwise the configured rate, and the next whole interval after now on the venue's clock.
   */
  private publishedFunding(market: SimMarketConfig): MaybeKnown<UserVenueFunding> {
    const funding = market.funding;
    if (!funding) return { known: false };
    if (!funding.settles) {
      const step = funding.intervalSeconds * 1000;
      const next = (Math.floor(this.clock().getTime() / step) + 1) * step;
      return { known: true, value: { rate: funding.rate, intervalSeconds: funding.intervalSeconds, nextFundingAt: new Date(next) } };
    }
    if (!this.fundingStateOf(market).published) return { known: false };
    const { rate, inputs } = this.builtRate(market);
    return {
      known: true,
      value: {
        rate,
        intervalSeconds: funding.intervalSeconds,
        nextFundingAt: new Date(this.nextFundingAt(market)),
        // The premium is taken from the index: while the venue publishes no index, it publishes no inputs either.
        inputs: this.indexUnpublished.has(market.symbol) ? { known: false } : { known: true, value: inputs },
      },
    };
  }

  /** The rate a settling market builds now from its mark and index (`SimMarketConfig.funding`), and its inputs. */
  private builtRate(market: SimMarketConfig) {
    const settles = market.funding!.settles!;
    const markPrice = this.marks.get(market.symbol);
    const indexPrice = this.indexes.get(market.symbol);
    if (markPrice === undefined || indexPrice === undefined)
      throw new Error(`TEST simulator: ${market.symbol} has no mark or index to build funding from`);
    const premium = truncate(div(sub(markPrice, indexPrice), indexPrice), 10);
    const rate = max(sub(ZERO, settles.rateCap), min(settles.rateCap, add(premium, settles.interestRate)));
    return {
      rate,
      inputs: {
        premium,
        interestRate: settles.interestRate,
        rateCap: settles.rateCap,
        markPrice,
        indexPrice,
        rule: published(settles.rule),
      },
    };
  }

  private settlingMarket(symbol: string): SimMarketConfig {
    const market = this.market(symbol);
    if (market.kind !== 'perpetual' || !market.funding?.settles)
      refuse(this.venue.id, 'not_offered', `${symbol} settles no funding on ${this.venue.displayName}`);
    return market;
  }

  private fundingStateOf(market: SimMarketConfig) {
    let state = this.fundingState.get(market.symbol);
    if (!state) {
      state = { published: true, nextAt: null, settled: [] };
      this.fundingState.set(market.symbol, state);
    }
    return state;
  }

  /**
   * The next period a settling market closes: one interval after the last it closed, or the next whole interval after now
   * when that time has passed. TEST: the simulator closes a period only on `settleFunding`, so a period whose time passes
   * unclosed books nothing and is not in its history.
   */
  private nextFundingAt(market: SimMarketConfig): number {
    const state = this.fundingStateOf(market);
    const now = this.clock().getTime();
    if (state.nextAt === null || state.nextAt <= now) {
      const step = market.funding!.intervalSeconds * 1000;
      state.nextAt = (Math.floor(now / step) + 1) * step;
    }
    return state.nextAt;
  }

  /** Keeps the perpetual's mark and index now as published samples, each only when it changed. */
  private samplePrices(symbol: string): void {
    const market = this.marketsBySymbol.get(symbol);
    if (!market || market.kind !== 'perpetual') return;
    let kept = this.priceSamples.get(symbol);
    if (!kept) {
      kept = { mark: [], index: [] };
      this.priceSamples.set(symbol, kept);
    }
    const at = this.clock();
    const keep = (list: VenuePriceSample[], price: Amount | undefined) => {
      if (price === undefined || list.at(-1)?.price === price) return;
      list.push({ sampledAt: at, price });
      if (list.length > PRICE_SAMPLES_KEPT) list.shift();
    };
    keep(kept.mark, this.marks.get(symbol));
    if (!this.indexUnpublished.has(symbol)) keep(kept.index, this.indexes.get(symbol));
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
    this.runScheduledCancels();
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
        arrivals: [],
        leverage: new Map(),
        subAccounts: new Map(),
        transfers: new Map(),
        retiredAgents: new Set(),
        marketMargins: new Map(),
        stakes: new Map(),
        stakeRefs: new Set(),
        deficits: new Map(),
        settlements: [],
        scheduled: { cancelsAt: null, lastFired: null },
        feeTier: null,
        liquidations: [],
        deleverages: [],
        fundingPayments: [],
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
    if (intent.trigger) this.checkTriggerOnItsFace(market, intent);
    else if (intent.parentClientOrderKey) refuse(this.venue.id, 'venue_rejected', 'only a trigger order is attached to an entry order');
    this.checkPublishedRules(state, market, intent);
    if (market.kind === 'perpetual') {
      if (!intent.trigger && intent.reduceOnly && intent.type !== 'market' && intent.timeInForce !== 'IOC') {
        refuse(this.venue.id, 'not_offered', 'a resting reduce-only order is not offered on the TEST simulator: close with IOC or market');
      }
      const setting = state.leverage.get(market.symbol);
      if (!setting) {
        refuse(this.venue.id, 'leverage_not_set', `no leverage is set on ${market.symbol} for this account: set it first`);
      }
      if (!intent.reduceOnly && market.maxLeverageBps !== null && setting.leverageBps > market.maxLeverageBps)
        this.aboveCap(market, setting.leverageBps);
      // The venue's published tiers: an opening order may not take the position into a tier that allows less leverage.
      if (!intent.reduceOnly && market.marginTiers?.length) {
        const held = state.positions.get(market.symbol);
        const same = held && held.side === (intent.side === 'buy' ? 'long' : 'short');
        const notional = mul(add(same ? held.size : ZERO, intent.amount), intent.price, 'ceil');
        const tier = tierOf(market.marginTiers, notional);
        if (setting.leverageBps > tier.maxLeverageBps) {
          const n = market.marginTiers.indexOf(tier) + 1;
          refuse(
            this.venue.id,
            'leverage_above_cap',
            `a position of ${formatAmount(notional)} ${market.quoteAsset} on ${market.symbol} is in tier ${n}, which allows at most ${tier.maxLeverageBps / 10_000}x; ${setting.leverageBps / 10_000}x is above it`,
          );
        }
      }
      // The deployer's cap on open interest: an opening order may not take the market's open size past it.
      const oiCap = this.openInterestCaps.get(market.symbol) ?? null;
      if (!intent.reduceOnly && oiCap !== null) {
        const open = this.openInterestOf(market.symbol);
        if (compare(add(open, intent.amount), oiCap) > 0) {
          const base = market.baseAsset;
          refuse(
            this.venue.id,
            'open_interest_above_cap',
            `${market.listedBy?.kind === 'venue' ? `${this.venue.displayName} caps ${market.symbol}'s` : `${market.symbol}'s deployer caps its`} open interest at ${formatAmount(oiCap)} ${base}; ${formatAmount(open)} ${base} is open, so ${formatAmount(intent.amount)} ${base} more would pass the cap`,
          );
        }
      }
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

  /** A trigger order's own rules: a perpetual whose venue takes triggers on its source, reduce-only, priced on the tick. */
  private checkTriggerOnItsFace(market: SimMarketConfig, intent: PlaceUserOrderIntent): void {
    const trigger = intent.trigger as VenueTrigger;
    if (market.kind !== 'perpetual') refuse(this.venue.id, 'not_offered', `${market.symbol} is cash spot: no trigger orders`);
    if (!(market.triggerSources ?? []).includes(trigger.source))
      refuse(this.venue.id, 'not_offered', `trigger orders judged on the ${trigger.source} price are not offered on ${market.symbol}`);
    if (trigger.role !== 'take_profit' && trigger.role !== 'stop_loss')
      refuse(this.venue.id, 'venue_rejected', 'a trigger order is a take profit or a stop loss');
    if (!intent.reduceOnly) refuse(this.venue.id, 'not_offered', 'a trigger order is reduce-only on this venue: it closes, never opens');
    if (compare(trigger.price, ZERO) <= 0) refuse(this.venue.id, 'venue_rejected', 'a trigger price must be above zero');
    if (trigger.price % market.tickSize !== ZERO)
      refuse(this.venue.id, 'venue_rejected', `the trigger price is not a multiple of the tick size on ${market.symbol}`);
    if (intent.type === 'limit' && intent.timeInForce !== 'GTC')
      refuse(this.venue.id, 'not_offered', 'a triggered limit order rests GTC on this venue');
  }

  /**
   * Orders signed together, applied one after the other in the order sent, each as if it were signed alone (every check
   * on the signed fields runs again for each), and each answered on its own: one refused does not undo the one before.
   */
  private applyTogether(prepared: PreparedVenueAction, intent: PlaceUserOrdersIntent): VenueSubmitOutcome {
    const now = this.clock();
    try {
      assertSignerMaySign(prepared.account, prepared.signer, intent);
      this.validate(prepared.account, prepared.signer, intent);
    } catch (error) {
      if (error instanceof VenueRefusalError) {
        return {
          definite: true,
          accepted: false,
          refusal: { venueId: this.venue.id, code: error.refusal.code, detail: error.refusal.detail },
          asOf: now,
        };
      }
      throw error;
    }
    const legs: VenueLegOutcome[] = [];
    for (const order of intent.orders) {
      const leg = this.apply({ ...prepared, intent: order, venueClientOrderId: venueClientOrderId(this.venue.id, order.clientOrderKey) });
      // An order is placed inside the action, so a fill it makes may fire a trigger order before the next is placed.
      this.runTriggers();
      if (!leg.definite) throw new Error('a TEST venue order answers definitely');
      legs.push(leg);
    }
    return { definite: true, accepted: true, venueRef: null, order: null, legs, asOf: now };
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

  /** A live order of this account on `symbol`, by its client id; refuses `unknown_order` or `order_final`. */
  private restingOrder(state: AccountState, symbol: string, cloid: string): OrderState {
    const found = state.orders.get(cloid);
    if (!found || found.order.symbol !== symbol) refuse(this.venue.id, 'unknown_order', `no order ${cloid} on ${symbol}`);
    if (!isLive(found)) refuse(this.venue.id, 'order_final', `the order is already ${found.order.status}`);
    return found;
  }

  /** The signer's authority and the action's face, checked again at submit: a definite refusal, or null. */
  private refusalAtSubmit(prepared: PreparedVenueAction): VenueSubmitOutcome | null {
    try {
      assertSignerMaySign(prepared.account, prepared.signer, prepared.intent);
      if (prepared.signer.role === 'agent' && !this.agentLive(this.account(prepared.account), prepared.signer.address))
        refuse(this.venue.id, 'signer_not_authorised', 'the agent key is not approved on this account, or has expired');
      this.validate(prepared.account, prepared.signer, prepared.intent);
      return null;
    } catch (error) {
      if (error instanceof VenueRefusalError)
        return {
          definite: true,
          accepted: false,
          refusal: { venueId: this.venue.id, code: error.refusal.code, detail: error.refusal.detail },
          asOf: this.clock(),
        };
      throw error;
    }
  }

  /** One cancel inside a signed action: the venue's own answer for that order. */
  private cancelOne(state: AccountState, symbol: string, cloid: string): VenueLegOutcome {
    const now = this.clock();
    const found = state.orders.get(cloid);
    if (!found || found.order.symbol !== symbol)
      return {
        definite: true,
        accepted: false,
        refusal: { venueId: this.venue.id, code: 'unknown_order', detail: `no order ${cloid} on ${symbol}` },
        asOf: now,
      };
    if (!isLive(found)) {
      // A repeat cancel reports the same outcome.
      if (found.order.status === 'canceled')
        return { definite: true, accepted: true, venueRef: found.order.venueOrderId, order: found.order, asOf: now };
      return {
        definite: true,
        accepted: false,
        refusal: { venueId: this.venue.id, code: 'order_final', detail: `the order is already ${found.order.status}` },
        asOf: now,
      };
    }
    this.release(found, 'canceled');
    return { definite: true, accepted: true, venueRef: found.order.venueOrderId, order: found.order, asOf: now };
  }

  /**
   * A cancel-and-replace signed once: the original is cancelled first (its lock released once), then the replacement is
   * placed under its own client id. Sent again, it answers as the first time: the replacement already placed is the
   * same order, and the original stays cancelled.
   */
  private applyReplace(prepared: PreparedVenueAction, intent: ReplaceUserOrderIntent): VenueSubmitOutcome {
    const state = this.account(prepared.account);
    const now = this.clock();
    const newId = venueClientOrderId(this.venue.id, intent.order.clientOrderKey);
    const placed = state.orders.get(newId);
    const original = state.orders.get(intent.venueClientOrderId);
    if (placed && original) {
      const leg: VenueLegOutcome = { definite: true, accepted: true, venueRef: placed.order.venueOrderId, order: placed.order, asOf: now };
      return {
        definite: true,
        accepted: true,
        venueRef: null,
        order: null,
        legs: [this.cancelOne(state, intent.symbol, intent.venueClientOrderId), leg],
        asOf: now,
      };
    }
    const refusal = this.refusalAtSubmit(prepared);
    if (refusal) return refusal;
    const cancel = this.cancelOne(state, intent.symbol, intent.venueClientOrderId);
    if (!cancel.accepted) return cancel;
    const leg = this.apply({ ...prepared, intent: intent.order, venueClientOrderId: newId });
    this.runTriggers();
    if (!leg.definite) throw new Error('a TEST venue order answers definitely');
    return { definite: true, accepted: true, venueRef: null, order: null, legs: [cancel, leg], asOf: now };
  }

  /** Several cancels signed once: each order answered on its own, in the order named. */
  private applyCancels(prepared: PreparedVenueAction, intent: CancelUserOrdersIntent): VenueSubmitOutcome {
    const refusal = this.refusalAtSubmit(prepared);
    if (refusal) return refusal;
    const state = this.account(prepared.account);
    const legs = intent.orders.map((o) => this.cancelOne(state, o.symbol, o.venueClientOrderId));
    return { definite: true, accepted: true, venueRef: null, order: null, legs, asOf: this.clock() };
  }

  private apply(prepared: PreparedVenueAction): VenueSubmitOutcome {
    if (prepared.intent.kind === 'place_orders') return this.applyTogether(prepared, prepared.intent);
    if (prepared.intent.kind === 'replace_order') return this.applyReplace(prepared, prepared.intent);
    if (prepared.intent.kind === 'cancel_orders') return this.applyCancels(prepared, prepared.intent);
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
      case 'schedule_cancel':
        state.scheduled = { ...state.scheduled, cancelsAt: intent.time === null ? null : new Date(intent.time) };
        return accepted(null, null);
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
      case 'amend_order': {
        // Lowered in place: the same order, its place in the queue (`seq`) kept, its lock cut by what the cut amount locked.
        const resting = this.restingOrder(state, intent.symbol, intent.venueClientOrderId);
        const o = resting.order;
        const cut = sub(o.remaining, intent.amount);
        const freed = min(o.locked, mul(resting.lockPerUnit, cut, 'floor'));
        const balance = this.lockBalance(state, resting.marginAccount, o.lockedAsset);
        balance.locked = sub(balance.locked, freed);
        balance.free = add(balance.free, freed);
        resting.order = { ...o, amount: add(o.filled, intent.amount), remaining: intent.amount, locked: sub(o.locked, freed) };
        return accepted(resting.order.venueOrderId, resting.order);
      }
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
          requestedAt: this.clock(),
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
        // An open position takes its margin at the new leverage (J-derivatives-05 #4): the difference is posted from
        // free or released to free, once, as `leverageChange` stated it before the wallet signed.
        if (position && position.size !== ZERO) {
          const market = this.market(intent.symbol);
          const usdc = this.lockBalance(
            state,
            market.marginAccount?.name ?? null,
            market.marginAccount?.collateralAsset ?? market.quoteAsset,
          );
          const after = this.marginAt(position, intent.leverageBps);
          const difference = sub(after, position.margin);
          if (compare(difference, usdc.free) > 0)
            return refused('insufficient_balance', `free margin does not cover the ${formatAmount(difference)} more this leverage needs`);
          usdc.free = sub(usdc.free, difference);
          usdc.locked = add(usdc.locked, difference);
          position.margin = after;
          position.leverageBps = intent.leverageBps;
        }
        state.leverage.set(intent.symbol, { leverageBps: intent.leverageBps, marginMode: intent.marginMode });
        return accepted(null, null);
      }
      case 'update_isolated_margin': {
        // One signed change moves collateral between free and the position's margin, once (J-derivatives-06 #2 #3); a
        // removal is refused below the venue's limit for the position, in words, and nothing moves.
        const position = this.openIsolated(state, intent.symbol);
        const market = this.market(intent.symbol);
        const usdc = this.lockBalance(
          state,
          market.marginAccount?.name ?? null,
          market.marginAccount?.collateralAsset ?? market.quoteAsset,
        );
        if (intent.direction === 'add') {
          if (compare(intent.amount, usdc.free) > 0)
            return refused(
              'insufficient_balance',
              `free margin ${formatAmount(usdc.free)} does not cover the ${formatAmount(intent.amount)} to add`,
            );
          usdc.free = sub(usdc.free, intent.amount);
          usdc.locked = add(usdc.locked, intent.amount);
          position.margin = add(position.margin, intent.amount);
        } else {
          // validate() above refused a removal past the venue's limit.
          usdc.locked = sub(usdc.locked, intent.amount);
          usdc.free = add(usdc.free, intent.amount);
          position.margin = sub(position.margin, intent.amount);
        }
        return accepted(prepared.nonce, null);
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
      case 'market_margin_transfer': {
        const rule = this.marginAccountOf(intent.symbol);
        const into = intent.direction === 'into_market';
        const main = this.balance(state, intent.asset);
        const margin = this.marketMarginOf(state, rule.name);
        const from = into ? main : margin;
        if (compare(from.free, intent.amount) < 0) {
          return refused(
            'insufficient_balance',
            `free ${intent.asset} ${into ? 'on the main account' : `in ${rule.name}`} does not cover the move (what is locked or held as margin stays)`,
          );
        }
        const to = into ? margin : main;
        from.free = sub(from.free, intent.amount);
        to.free = add(to.free, intent.amount);
        return accepted(prepared.nonce, null);
      }
    }
  }

  /** The owner's balance in a deployer's margin account, made on first use. */
  private marketMarginOf(state: AccountState, name: string): { free: Amount; locked: Amount } {
    let b = state.marketMargins.get(name);
    if (!b) {
      b = { free: ZERO, locked: ZERO };
      state.marketMargins.set(name, b);
    }
    return b;
  }

  /** Where an order's lock and a position's margin sit: the market's own margin account, or the main balance of `asset`. */
  private lockBalance(state: AccountState, marginAccount: string | null, asset: string): { free: Amount; locked: Amount } {
    return marginAccount === null ? this.balance(state, asset) : this.marketMarginOf(state, marginAccount);
  }

  /** A market's open interest: the long size open across every account (equal to the short size), in base units. */
  private openInterestOf(symbol: string): Amount {
    let open = ZERO;
    for (const state of this.accounts.values()) {
      const p = state.positions.get(symbol);
      if (p && p.side === 'long') open = add(open, p.size);
    }
    return open;
  }

  private place(
    state: AccountState,
    intent: PlaceUserOrderIntent,
    cloid: string,
    builderFee: PreparedVenueAction['builderFee'],
    refused: (code: VenueRefusalCode, detail: string) => VenueSubmitOutcome,
    accepted: (venueRef: string | null, order: UserVenueOrder | null) => VenueSubmitOutcome,
  ): VenueSubmitOutcome {
    if (intent.trigger) return this.placeTrigger(state, intent, cloid, builderFee, refused, accepted);
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

    const { lockAsset, lockPerUnit, lockAmount } = this.orderLock(market, intent, setting, builderFee, state);
    // A market with its deployer's own margin account locks there, never on the main account.
    const marginAccount = perp && market.marginAccount ? market.marginAccount.name : null;
    const balance = this.lockBalance(state, marginAccount, lockAsset);
    if (compare(balance.free, lockAmount) < 0)
      return refused(
        'insufficient_balance',
        `free ${lockAsset}${marginAccount ? ` in ${marginAccount}` : ''} does not cover ${perp ? 'the margin and fees' : 'what'} this order locks`,
      );
    // Self-trade prevention: this account's own resting orders that the new order would cross are cancelled now.
    for (const own of contra().filter((o) => o.account === state && crossesPrice(o))) this.release(own, 'canceled');
    balance.free = sub(balance.free, lockAmount);
    balance.locked = add(balance.locked, lockAmount);

    this.venueOrderCounter += 1;
    this.seqCounter += 1;
    const order: OrderState = {
      account: state,
      seq: this.seqCounter,
      placedAt: this.clock(),
      builderFee,
      leverageBps: setting?.leverageBps ?? null,
      marginMode: setting?.marginMode ?? null,
      lockPerUnit,
      marginAccount,
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
      if (order.order.remaining === ZERO || !isLive(order)) break;
      // A fill can close a position and cancel its other reduce-only orders: one cancelled meanwhile is not traded.
      if (!isLive(maker)) continue;
      const qty = min(order.order.remaining, maker.order.remaining);
      this.fill(market, maker, order, qty, maker.order.price);
    }

    if (order.order.remaining !== ZERO && isLive(order)) {
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
    state: AccountState,
  ): { lockAsset: string; lockPerUnit: Amount; lockAmount: Amount } {
    // A perp order also locks the most it can pay in fees: the fee charged, even when the venue does not publish it.
    const maxFeeBps = add(this.chargedFeeBps(market, 'taker', state), builderFee?.feeBps ?? ZERO);
    const feeBuffer = (notional: Amount) => div(mul(notional, maxFeeBps, QUOTE_ROUND), BPS, QUOTE_ROUND);
    let lockAsset: string;
    let lockPerUnit: Amount;
    if (market.kind === 'perpetual') {
      lockAsset = market.marginAccount?.collateralAsset ?? market.quoteAsset;
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

  /**
   * The venue's own published rules (J-cex-spot-04), each enforced only while it is published: the smallest order value,
   * the price band around the middle of the venue's own book (the one side it has when the other is empty; no band
   * applies to an empty book), and the most open orders one account may hold. The words name the rule and its figure.
   * A market order's price is only its worst bound (a market sell may carry one tick), so its value is taken at the
   * book's reference price, as a venue values a market order; with no reference, at its bound. A trigger order's limit
   * price is checked against the band when it triggers, not when it is placed, so the band leaves it alone here.
   */
  private checkPublishedRules(state: AccountState, market: SimMarketConfig, intent: PlaceUserOrderIntent): void {
    const own = this.marketState.get(market.symbol)!;
    const quote = market.quoteAsset;
    let bid: Amount | null = null;
    let ask: Amount | null = null;
    for (const o of this.bookOf(market.symbol)) {
      if (o.order.side === 'buy' && (bid === null || compare(o.order.price, bid) > 0)) bid = o.order.price;
      if (o.order.side === 'sell' && (ask === null || compare(o.order.price, ask) < 0)) ask = o.order.price;
    }
    const reference = bid !== null && ask !== null ? div(add(bid, ask), parseAmount('2'), 'floor') : (bid ?? ask);
    const valuedAt = intent.type === 'market' && reference !== null ? reference : intent.price;
    if (own.minOrderNotional !== null && compare(mul(intent.amount, valuedAt, 'floor'), own.minOrderNotional) < 0) {
      refuse(
        this.venue.id,
        'order_below_venue_min',
        `the order's value is below the smallest order on ${market.symbol}, ${formatAmount(own.minOrderNotional)} ${quote}`,
      );
    }
    if (own.priceBandBps !== null && intent.type === 'limit' && !intent.trigger && reference !== null) {
      const reach = div(mul(reference, own.priceBandBps, 'floor'), BPS, 'floor');
      const low = sub(reference, reach);
      const high = add(reference, reach);
      if (compare(intent.price, low) < 0 || compare(intent.price, high) > 0) {
        refuse(
          this.venue.id,
          'price_outside_venue_band',
          `${market.symbol} takes limit prices from ${formatAmount(low)} to ${formatAmount(high)} ${quote} right now (within ${formatAmount(own.priceBandBps)} bps of ${formatAmount(reference)})`,
        );
      }
    }
    if (own.maxOpenOrders !== null) {
      const open = [...state.orders.values()].filter(isLive).length;
      if (open >= own.maxOpenOrders) {
        refuse(
          this.venue.id,
          'open_orders_above_venue_cap',
          `this account has ${open} open orders and ${this.venue.displayName} allows ${own.maxOpenOrders}`,
        );
      }
    }
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
      const feeBps = this.chargedFeeBps(market, role, side.account);
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
      // A protection attached to this entry arms on what the entry has filled, never on more (`normalTpsl`).
      if (!o.reduceOnly) this.armChildren(side);
      // One leg of a pair attached to the same entry fills: the venue cancels the other (`linked`), part filled or whole.
      else if (side.parent) this.cancelLinked(side);

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
    // One public print per match, at the maker's price, the taker's side the one that crossed.
    const prints = this.prints.get(market.symbol) ?? [];
    this.printCounter += 1;
    prints.push({
      tradeId: `sim-print-${this.printCounter}`,
      symbol: market.symbol,
      price,
      amount: qty,
      takerSide: taker.order.side,
      tradedAt: now,
    });
    if (prints.length > PRINTS_KEPT) prints.splice(0, prints.length - PRINTS_KEPT);
    this.prints.set(market.symbol, prints);
    // An oracle market's mark is the oracle price: a fill does not move it.
    if (market.kind === 'perpetual' && !market.oracle) {
      this.marks.set(market.symbol, price);
      this.samplePrices(market.symbol);
    }
    if (market.kind === 'perpetual') {
      this.lastTrades.set(market.symbol, price);
      // A position closed to nothing takes its reduce-only orders with it: a pair's other leg never fires on nothing.
      for (const side of [maker, taker]) {
        if (!side.order.reduceOnly) continue;
        const p = side.account.positions.get(market.symbol);
        if (!p || p.size === ZERO) this.cancelProtections(side.account, market.symbol, taker);
      }
    }
  }

  /** Every live reduce-only order of `state` on `symbol`, waiting triggers included, cancelled `position_closed`. */
  private cancelProtections(state: AccountState, symbol: string, except: OrderState): void {
    for (const o of [...state.orders.values()]) {
      if (o === except || o.order.symbol !== symbol || !o.order.reduceOnly || !isLive(o)) continue;
      this.release(o, 'canceled', 'position_closed');
    }
  }

  /** The other waiting trigger orders attached to the same entry as `leg`, cancelled `linked` once `leg` has filled. */
  private cancelLinked(leg: OrderState): void {
    for (const o of [...leg.account.orders.values()]) {
      if (o === leg || o.parent !== leg.parent || !isLive(o) || o.order.trigger?.state !== 'waiting') continue;
      this.release(o, 'canceled', 'linked');
    }
  }

  /** The waiting protections attached to `entry`, sized to what it has filled so far, never above what was asked. */
  private armChildren(entry: OrderState): void {
    for (const o of entry.account.orders.values()) {
      if (o.parent !== entry || !isLive(o) || o.order.trigger?.state !== 'waiting') continue;
      const amount = min(o.requested ?? o.order.amount, entry.order.filled);
      if (amount !== ZERO) o.order = { ...o.order, amount, remaining: amount };
    }
  }

  /**
   * A trigger order (`intent.trigger`): checked against the position (or the entry it is attached to) and the price it
   * is judged on now, its most fees locked, and kept off the book until its source crosses its price (`runTriggers`).
   */
  private placeTrigger(
    state: AccountState,
    intent: PlaceUserOrderIntent,
    cloid: string,
    builderFee: PreparedVenueAction['builderFee'],
    refused: (code: VenueRefusalCode, detail: string) => VenueSubmitOutcome,
    accepted: (venueRef: string | null, order: UserVenueOrder | null) => VenueSubmitOutcome,
  ): VenueSubmitOutcome {
    const market = this.market(intent.symbol);
    const trigger = intent.trigger as VenueTrigger;
    const setting = state.leverage.get(market.symbol);
    if (!setting) return refused('leverage_not_set', `no leverage is set on ${market.symbol} for this account`);
    let parent: OrderState | null = null;
    if (intent.parentClientOrderKey) {
      parent = state.orders.get(venueClientOrderId(this.venue.id, intent.parentClientOrderKey)) ?? null;
      if (!parent || parent.order.symbol !== market.symbol || parent.order.reduceOnly)
        return refused('venue_rejected', 'the entry order this protection is attached to is not an opening order on this account');
      if (parent.order.side === intent.side) return refused('venue_rejected', 'a protection closes its entry: it is on the other side');
      if (compare(intent.amount, parent.order.amount) > 0) return refused('venue_rejected', 'a protection is larger than its entry order');
      if (!isLive(parent) && parent.order.filled === ZERO)
        return refused('venue_rejected', 'the entry order ended without a fill: there is nothing to protect');
    } else {
      const p = state.positions.get(market.symbol);
      const held = p !== undefined && p.size !== ZERO ? p : undefined;
      if (!held || (held.side === 'long') === (intent.side === 'buy'))
        return refused('venue_rejected', 'reduce-only order would open or grow a position');
      if (compare(intent.amount, held.size) > 0) return refused('venue_rejected', 'reduce-only order is larger than the position');
    }
    const now = this.sourcePrice(market.symbol, trigger.source);
    if (now !== null && crossed(intent.side, trigger, now)) {
      const want = (trigger.role === 'take_profit') === (intent.side === 'sell') ? 'above' : 'below';
      return refused(
        'venue_rejected',
        `a ${trigger.role === 'take_profit' ? 'take profit' : 'stop loss'} on this side must trigger ${want} the ${trigger.source} price ${formatAmount(now)}: this one would fire at once`,
      );
    }
    const { lockAsset, lockPerUnit } = this.orderLock(market, intent, setting, builderFee, state);
    const amount = parent && parent.order.filled !== ZERO ? min(intent.amount, parent.order.filled) : intent.amount;
    const lockAmount = mul(lockPerUnit, intent.amount, QUOTE_ROUND);
    const marginAccount = market.marginAccount ? market.marginAccount.name : null;
    const balance = this.lockBalance(state, marginAccount, lockAsset);
    if (compare(balance.free, lockAmount) < 0)
      return refused('insufficient_balance', `free ${lockAsset} does not cover the most this trigger order can pay in fees`);
    balance.free = sub(balance.free, lockAmount);
    balance.locked = add(balance.locked, lockAmount);
    this.venueOrderCounter += 1;
    this.seqCounter += 1;
    const order: OrderState = {
      account: state,
      seq: this.seqCounter,
      placedAt: this.clock(),
      builderFee,
      leverageBps: setting.leverageBps,
      marginMode: setting.marginMode,
      lockPerUnit,
      marginAccount,
      parent,
      requested: intent.amount,
      order: {
        venueOrderId: `sim-${this.venueOrderCounter}`,
        venueClientOrderId: cloid,
        symbol: market.symbol,
        side: intent.side,
        type: intent.type,
        timeInForce: intent.timeInForce,
        price: intent.price,
        amount,
        filled: ZERO,
        remaining: amount,
        averagePrice: null,
        status: 'open',
        locked: lockAmount,
        lockedAsset: lockAsset,
        reduceOnly: true,
        trigger: { price: trigger.price, source: trigger.source, role: trigger.role, state: 'waiting', triggeredAt: null, failure: null },
        parentClientOrderId: parent?.order.venueClientOrderId ?? null,
        cancelReason: null,
      },
    };
    state.orders.set(cloid, order);
    this.triggers.get(market.symbol)!.push(order);
    return accepted(order.order.venueOrderId, order.order);
  }

  /** The price a trigger is judged on now, or `null` while there is none (no trade yet on `last`). */
  private sourcePrice(symbol: string, source: VenueTriggerSource): Amount | null {
    return (source === 'mark' ? this.marks.get(symbol) : this.lastTrades.get(symbol)) ?? null;
  }

  /**
   * Fire every waiting trigger order whose source has crossed its price, oldest first, until none is left to fire. Each
   * fires once: it leaves the waiting list before it is sent, and a fill it makes is judged only after it is done.
   */
  private runTriggers(): void {
    if (this.firing) return;
    this.firing = true;
    try {
      for (let round = 0; round < 100; round += 1) {
        let fired = false;
        for (const [symbol, waiting] of this.triggers) {
          for (const o of [...waiting].sort((a, b) => a.seq - b.seq)) {
            const trigger = o.order.trigger;
            if (!isLive(o) || !trigger || trigger.state !== 'waiting') continue;
            if (o.parent && o.parent.order.filled === ZERO) continue;
            const now = this.sourcePrice(symbol, trigger.source);
            if (now === null || !crossed(o.order.side, trigger, now)) continue;
            this.fire(o);
            fired = true;
          }
        }
        if (!fired) return;
      }
      throw new Error('TEST simulator invariant: trigger orders kept firing for 100 rounds');
    } finally {
      this.firing = false;
    }
  }

  /**
   * One trigger order's source crossed its price: sent as the order it carries, for no more than the position holds
   * (and the entry filled), against other traders' resting orders. A market order that finds nothing at or better than
   * its worst price fails, in the venue's words, and closes nothing; a limit rests on the book at its price.
   */
  private fire(o: OrderState): void {
    const state = o.account;
    const market = this.market(o.order.symbol);
    const waiting = this.triggers.get(market.symbol)!;
    waiting.splice(waiting.indexOf(o), 1);
    const p = state.positions.get(market.symbol);
    const held = p && p.size !== ZERO && (p.side === 'long') === (o.order.side === 'sell') ? p : undefined;
    if (!held) {
      this.release(o, 'canceled', 'position_closed');
      return;
    }
    let qty = min(o.order.remaining, held.size);
    if (o.parent) qty = min(qty, o.parent.order.filled);
    // Its lock, sized again to what it now closes.
    const balance = this.lockBalance(state, o.marginAccount, o.order.lockedAsset);
    const lock = mul(o.lockPerUnit, qty, QUOTE_ROUND);
    balance.locked = add(sub(balance.locked, o.order.locked), lock);
    balance.free = sub(add(balance.free, o.order.locked), lock);
    const at = this.clock();
    o.order = {
      ...o.order,
      amount: qty,
      remaining: qty,
      locked: lock,
      trigger: { ...o.order.trigger!, state: 'triggered', triggeredAt: at },
    };
    const sell = o.order.side === 'sell';
    const ordered = this.bookOf(market.symbol)
      .filter((m) => m.account !== state && m.order.side !== o.order.side)
      .filter((m) => (sell ? compare(m.order.price, o.order.price) >= 0 : compare(m.order.price, o.order.price) <= 0))
      .sort((a, b) => (sell ? compare(b.order.price, a.order.price) : compare(a.order.price, b.order.price)) || a.seq - b.seq);
    for (const maker of ordered) {
      if (o.order.remaining === ZERO || !isLive(o)) break;
      if (!isLive(maker)) continue;
      this.fill(market, maker, o, min(o.order.remaining, maker.order.remaining), maker.order.price);
    }
    if (o.order.remaining === ZERO || !isLive(o)) return;
    if (o.order.type === 'limit') {
      this.bookOf(market.symbol).push(o);
      return;
    }
    if (o.order.filled === ZERO) {
      this.release(o, 'rejected');
      o.order = {
        ...o.order,
        trigger: {
          ...o.order.trigger!,
          state: 'failed',
          failure: `no ${sell ? 'buy' : 'sell'} order rests at or ${sell ? 'above' : 'below'} the worst price ${formatAmount(o.order.price)} ${market.quoteAsset}, so the triggered order did not fill`,
        },
      };
      return;
    }
    this.release(o, 'canceled');
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
    const lockBalance = this.lockBalance(state, side.marginAccount, o.lockedAsset);
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
    const usdc = this.lockBalance(state, market.marginAccount?.name ?? null, market.marginAccount?.collateralAsset ?? market.quoteAsset);
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

  /** A position's margin at `leverageBps`: its entry notional over the leverage, as an opening fill posts it. */
  private marginAt(p: PositionState, leverageBps: number): Amount {
    return div(mul(mul(p.entryPrice, p.size, QUOTE_ROUND), BPS), parseAmount(String(leverageBps)), QUOTE_ROUND);
  }

  /** The margin the simulator requires to keep `p` open: its entry notional at the market's maintenance rate (TEST). */
  private maintenanceOf(market: SimMarketConfig, p: PositionState): MaybeKnown<Amount> {
    const notional = mul(p.entryPrice, p.size);
    const rate = market.marginTiers?.length ? tierOf(market.marginTiers, notional).maintenanceRate : market.maintenanceMarginRate;
    return rate === undefined ? { known: false } : { known: true, value: mul(notional, rate) };
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
    const notional = mul(p.entryPrice, p.size);
    const rate = market.marginTiers?.length ? tierOf(market.marginTiers, notional).maintenanceRate : market.maintenanceMarginRate;
    if (rate === undefined) return { known: false };
    const maintenance = mul(notional, rate);
    const cushion = div(sub(p.margin, maintenance), p.size, 'floor');
    const price = p.side === 'long' ? sub(p.entryPrice, cushion) : add(p.entryPrice, cushion);
    return { known: true, value: max(ZERO, price) };
  }

  /** The venue's liquidation rules on `symbol`; a market it liquidates nothing on refuses `not_offered`. */
  private liquidationRules(symbol: string): { feeRate: Amount; priceRule: string; feeRule: string } {
    const market = this.market(symbol);
    if (market.kind !== 'perpetual' || !market.liquidation)
      refuse(this.venue.id, 'not_offered', `${this.venue.displayName} runs no liquidation on ${symbol} and publishes no rule for one`);
    return market.liquidation;
  }

  /** While a position's liquidation is in progress the venue takes no change to it: no order, leverage or margin change. */
  private refuseDuringLiquidation(state: AccountState, intent: VenueIntent): void {
    const symbols =
      intent.kind === 'place_orders'
        ? intent.orders.map((o) => o.symbol)
        : intent.kind === 'place_order' ||
            intent.kind === 'update_leverage' ||
            intent.kind === 'update_isolated_margin' ||
            intent.kind === 'amend_order' ||
            intent.kind === 'replace_order'
          ? [intent.symbol]
          : [];
    for (const symbol of symbols) {
      const live = state.liquidations.find((l) => l.symbol === symbol && l.state === 'in_progress');
      if (live)
        refuse(
          this.venue.id,
          'venue_rejected',
          `${symbol} is being liquidated (${live.liquidationId}): ${this.venue.displayName} takes no order, leverage or margin change on the position until its liquidation is done`,
        );
    }
  }

  /**
   * The venue's liquidation pass on `symbol` after its mark moved: a liquidation in progress closes the rest of its
   * position at the new mark; a position the mark has reached the liquidation price of starts one, closing half of it.
   */
  private runLiquidations(symbol: string): void {
    const market = this.market(symbol);
    if (market.kind !== 'perpetual' || !market.liquidation) return;
    const mark = this.marks.get(symbol);
    if (mark === undefined) return;
    for (const state of this.accounts.values()) {
      const p = state.positions.get(symbol);
      const live = state.liquidations.find((l) => l.symbol === symbol && l.state === 'in_progress');
      if (live) {
        if (p && p.size !== ZERO)
          live.parts.push(this.liquidatePart(state, market, p, p.size, mark, live.liquidationId, live.parts.length + 1));
        live.state = 'done';
        continue;
      }
      if (!p || p.size === ZERO) continue;
      const liq = this.liquidationPrice(market, p);
      if (!liq.known) continue;
      const reached = p.side === 'long' ? compare(mark, liq.value) <= 0 : compare(mark, liq.value) >= 0;
      if (!reached) continue;
      this.cancelAllOn(state, symbol);
      const halfLots = div(div(p.size, parseAmount('2'), 'floor'), market.lotSize, 'floor');
      const half = mul(halfLots - (halfLots % parseAmount('1')), market.lotSize);
      const whole = half === ZERO || half === p.size;
      const liquidationId = `liq-${++this.liquidationCounter}`;
      const record: AccountState['liquidations'][number] = {
        liquidationId,
        symbol,
        side: p.side,
        state: whole ? 'done' : 'in_progress',
        parts: [],
        startedAt: this.clock(),
      };
      state.liquidations.push(record);
      record.parts.push(this.liquidatePart(state, market, p, whole ? p.size : half, mark, liquidationId, 1));
    }
  }

  /**
   * Close `qty` of `p` at `mark` as one liquidation part: the margin it held is released, its result settled (an isolated
   * loss stops at that margin), and the venue's fee, `feeRate` of the part's value capped at what the part leaves, paid
   * into the insurance fund. A loss past the margin is paid by the fund, up to what it holds.
   */
  private liquidatePart(
    state: AccountState,
    market: SimMarketConfig,
    p: PositionState,
    qty: Amount,
    mark: Amount,
    liquidationId: string,
    n: number,
  ): UserVenueLiquidationPart {
    const rules = market.liquidation!;
    const asset = market.marginAccount?.collateralAsset ?? market.quoteAsset;
    const usdc = this.lockBalance(state, market.marginAccount?.name ?? null, asset);
    const released = qty === p.size ? p.margin : div(mul(p.margin, qty), p.size, QUOTE_ROUND);
    const back = add(released, this.pnl(p, mark, qty));
    const fee = min(mul(mul(mark, qty), rules.feeRate, QUOTE_ROUND), max(back, ZERO));
    this.insurance.balance = add(this.insurance.balance, fee);
    if (compare(back, ZERO) < 0) this.insurance.balance = sub(this.insurance.balance, min(sub(ZERO, back), this.insurance.balance));
    usdc.locked = sub(usdc.locked, released);
    usdc.free = add(usdc.free, max(sub(back, fee), ZERO));
    p.margin = sub(p.margin, released);
    p.size = sub(p.size, qty);
    const at = this.clock();
    this.alert({ kind: 'liquidation', symbol: market.symbol, side: p.side, size: qty, price: mark, alertedAt: at });
    return { partId: `${liquidationId}-${n}`, size: qty, price: mark, fee, feeAsset: asset, liquidatedAt: at };
  }

  /** Cancel every resting and waiting order of the account on `symbol`, its locks released once. */
  private cancelAllOn(state: AccountState, symbol: string): void {
    for (const o of [...this.bookOf(symbol), ...(this.triggers.get(symbol) ?? [])])
      if (o.account === state && isLive(o)) this.release(o, 'canceled', 'position_closed');
  }

  private alert(a: VenueLiquidationAlert): void {
    this.alerts.push(a);
    if (this.alerts.length > ALERTS_KEPT) this.alerts.splice(0, this.alerts.length - ALERTS_KEPT);
  }

  /** End an order's remaining lock exactly once. */
  private release(
    order: OrderState,
    status: UserVenueOrder['status'],
    cancelReason: 'position_closed' | 'linked' | 'scheduled_cancel' | null = null,
  ): void {
    const o = order.order;
    if (o.locked !== ZERO) {
      const balance = this.lockBalance(order.account, order.marginAccount, o.lockedAsset);
      balance.locked = sub(balance.locked, o.locked);
      balance.free = add(balance.free, o.locked);
    }
    order.order = { ...order.order, locked: ZERO, status, ...(cancelReason ? { cancelReason } : {}) };
    const book = this.bookOf(o.symbol);
    const at = book.indexOf(order);
    if (at >= 0) book.splice(at, 1);
    const waiting = this.triggers.get(o.symbol) ?? [];
    const w = waiting.indexOf(order);
    if (w >= 0) waiting.splice(w, 1);
  }
}

/** A published word of the venue's, or `known: false` when it publishes none. */
/** The published tier a position notional falls in: the last whose `fromNotional` it reaches (the first from zero). */
function tierOf(tiers: readonly UserVenueMarginTier[], notional: Amount): UserVenueMarginTier {
  let at = tiers[0]!;
  for (const t of tiers) if (compare(notional, t.fromNotional) >= 0) at = t;
  return at;
}

function published<T>(value: T | undefined): MaybeKnown<T> {
  return value === undefined ? { known: false } : { known: true, value };
}

/**
 * Whether `price` has crossed a trigger for an order on `side`: a take profit when the price has moved in the position's
 * favour to it, a stop loss when against. A sell closes a long (take profit at or above, stop loss at or below); a buy
 * closes a short (the other way round).
 */
export function crossed(side: 'buy' | 'sell', trigger: VenueTrigger, price: Amount): boolean {
  const above = compare(price, trigger.price) >= 0;
  const below = compare(price, trigger.price) <= 0;
  if (trigger.role === 'take_profit') return side === 'sell' ? above : below;
  return side === 'sell' ? below : above;
}

function isLive(o: OrderState): boolean {
  return o.order.status === 'open' || o.order.status === 'partially_filled';
}
