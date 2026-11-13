import { venueGatedList, type VenueGatedBlocker, type VenueGatedContract } from './venue-gated-list.js';
import { createHash } from 'node:crypto';
import { hashTypedData, recoverTypedDataAddress, type Hex, type TypedDataDefinition } from 'viem';
import { formatAmount, parseAmount, type Amount } from '@intafaced/ledger-client/money';
import { AuthError, isApiKeyPrincipal, requireTradeTier, TIER_ORDER, type Principal } from '@intafaced/auth';
import type { StepUpCheck } from '@intafaced/contracts';
import {
  OWNER_ONLY_INTENTS,
  VenueRefusalError,
  hasSubAccountReads,
  assertSignatureMatches,
  encodeVenueWire,
  isTestVenue,
  refuseTestVenueOutsideTest,
  type PlaceUserOrderIntent,
  type PreparedVenueAction,
  type UserVenue,
  type UserVenueAccount,
  type UserVenueOrder,
  type UserVenueDepositRoute,
  type UserVenueMarket,
  type VenueBestPrices,
  type VenueIntent,
  type VenueRefusal,
  type VenueSignature,
  type VenueSigner,
  type VenueSubmitOutcome,
  SEND_AT_RE,
} from '@intafaced/venue-contracts';
import { requireMarketSlippageCapBps } from '../spot/risk.js';
import { TradeError } from '../spot/types.js';
import { GTD_KEY_PREFIX, type PreparedActionStore, type StoredVenueAction } from './prepared-action-store.js';
import { VenueRouteRefusal, type ListedVenueMarket, type VenueRouteRefusalCode, type VenueRoutingGate } from './venue-listing.js';
import { BuilderFeeVersionError, builderFeeOf, type BuilderFeeBook } from './builder-fee-versions.js';
import type { FeeSaverSource } from './fee-saver-client.js';

/**
 * THE USER-VENUE DOOR (B1; project-state #1789 item 2): the signed-in customer's own account on a user-signed venue,
 * through svc-trade. Off unless `TRADE_USER_VENUE_URL` is set.
 *
 * Prepare → the customer's wallet signs → submit (packages/venue-contracts/src/user-venue.ts). What this door adds:
 *
 *   · ONE PREPARED ACTION PER BUSINESS KEY. The prepared action is stored under its key before it is returned for
 *     signing, the first signature is stored before anything is sent, and a second prepare of the key returns the stored
 *     action (one wallet prompt). A re-submit re-sends the stored bytes. After `definite: false` the caller reads back
 *     (`readBack`) and never prepares a new key for the same intent.
 *   · Withdrawal: identity's step-up (`trade.step_up.venue.withdraw`) is spent before the venue is asked to prepare it.
 *   · Our builder fee comes from the owner's values, never from the request: the builder-fee version in force when the
 *     order is prepared for signing (by venue and market group, builder-fee-versions.ts), else the boot owner value.
 *     Blank, every order refuses `builder_fee_not_published` before the venue is asked (AGENTS.md floor 8). The prepared
 *     order keeps that fee: a version that takes effect later never changes an order already prepared or signed.
 *   · The ledger posts nothing and no event is sent: the venue is the record of balances, locks, fills and withdrawals.
 *   · Only markets two operators listed are shown, and a new order goes only where our listing, routing state, dates
 *     and largest order admit it (venue-listing.ts, J-cex-spot-16), checked at preview, at prepare and at first send.
 *     A cancel is never checked against them.
 */

/**
 * A withdrawal, and every grant of authority over the venue account (builder fee, agent approve or revoke), is the person's
 * own, from an interactive session: never from an API key or a sub-account token. This is the rule `trade:withdraw` keeps
 * on the custodial side (an interactive-only scope no key may hold), so a leaked `trade:write` key can trade but can never
 * send funds out or hand the account to someone else. Checked at prepare and again at submit.
 */
export function assertInteractive(principal: Principal, kind: VenueIntent['kind']): void {
  if (!OWNER_ONLY_INTENTS.has(kind)) return;
  if (isApiKeyPrincipal(principal) || principal.sub_account) {
    throw new AuthError(
      `a venue ${kind} needs the person's own signed-in session and cannot be made from an API key or a sub-account`,
      'scope.interactive_only',
    );
  }
}

/**
 * A new or changed order needs `basic`, or the trading checks' clear for trading (`trd`: J-cex-spot-01 #3, OWNER 258
 * (4), read through `tradeTier`), checked before anything is read, prepared or stored. A cancel, a withdrawal and the
 * grants stay open below it: they only reduce what is on the venue, so a held account never strands its own funds there.
 */
export function assertTradingLevel(principal: Principal, kind: VenueIntent['kind']): void {
  if (kind === 'place_order' || kind === 'amend_order') requireTradeTier(principal, 'basic');
}

/**
 * A person cleared by the trading checks alone (no approved level) withdraws only to their own wallet, the venue
 * account's owner (OWNER 298); a withdrawal to any other address keeps the approved level. Refused before anything is
 * stored or asked of the venue.
 */
export function assertOwnWalletWithdrawal(principal: Principal, owner: string, intent: VenueIntent): void {
  if (intent.kind !== 'withdraw' || TIER_ORDER[principal.tier] >= TIER_ORDER.basic) return;
  if (String(intent.destination ?? '').toLowerCase() !== owner.toLowerCase()) {
    throw new UserVenueDoorError(
      'until your identity is verified, a withdrawal goes only to your own wallet, the one this venue account belongs to',
      'trade.venue.withdraw_own_wallet_only',
      403,
    );
  }
}

const MARKET_KINDS_TTL_MS = 60_000;
/** On a symbol the list doesn't hold, the list is read again at most this often, so unlisted symbols can't each cost a venue read. */
const MARKET_MISS_REREAD_MS = 5_000;

/**
 * Opening a sub-account and moving funds into or out of one are the agent account's own actions (J-agents-21,
 * agent-account.ts): it checks the person's cap before the wallet is asked to sign a move in, and keeps the count of
 * moves the cap is held to. The plain door refuses them, at prepare and at submit, so no move reaches the venue around
 * that check.
 */
export const AGENT_ACCOUNT_INTENTS: ReadonlySet<VenueIntent['kind']> = new Set<VenueIntent['kind']>([
  'create_sub_account',
  'sub_account_transfer',
]);

/** How the agent account (agent-account.ts) calls the door for its own actions. */
export interface DoorCaller {
  readonly agentAccount?: boolean;
  /** Set only by a live strategy run (src/quant/live-run/live-runs.ts): its actions are stored under `algo:` keys. */
  readonly liveRun?: boolean;
}

/** A live strategy run's keys (`algo:order:`, `algo:liquidate:`, `algo:stop:`, `algo:deploy:`): only the run stores or sends one. */
export const LIVE_RUN_KEY_PREFIX = 'algo:';

function assertLiveRunKey(key: string, caller: DoorCaller | undefined): void {
  if (key.startsWith(LIVE_RUN_KEY_PREFIX) && !caller?.liveRun) {
    throw new UserVenueDoorError(`the key ${key} belongs to a live strategy run`, 'trade.venue_live_run_only', 403);
  }
}

/**
 * THE PERSON'S OWN SUB-ACCOUNT (J-portfolio-04 #2). Besides the agent account, a person may open a plain sub-account of
 * their own under their main venue account and move their own coins into and out of it, each signed by their wallet on the
 * main account. It is stored only under these keys, which only the plain door stores and only for these two intents:
 *
 *   · `own:sub-account:<owner>:<name>` for `create_sub_account`;
 *   · `own:move:<owner>:<id>` for `sub_account_transfer`, and only to or from a sub-account this person opened under an
 *     `own:sub-account:` key: never an agent account's, whose moves are held to the person's cap (agent-account.ts).
 *
 * Nothing leaves the venue and the ledger posts nothing: the coins only move between two accounts the same wallet owns.
 */
export const OWN_SUB_ACCOUNT_PREFIX = 'own:sub-account:';
export const OWN_MOVE_PREFIX = 'own:move:';

function isOwnSubAccountKey(kind: VenueIntent['kind'], key: string): boolean {
  if (kind === 'create_sub_account') return key.startsWith(OWN_SUB_ACCOUNT_PREFIX);
  if (kind === 'sub_account_transfer') return key.startsWith(OWN_MOVE_PREFIX);
  return false;
}

function assertDoorMay(kind: VenueIntent['kind'], caller: DoorCaller | undefined, key: string): void {
  if (AGENT_ACCOUNT_INTENTS.has(kind) && !caller?.agentAccount && !isOwnSubAccountKey(kind, key)) {
    throw new UserVenueDoorError(
      `a venue ${kind} is made only through the agent account (/api/v1/venue/agent-accounts), which holds it to the person's cap`,
      'trade.venue_agent_account_only',
      403,
    );
  }
}

/** The key prefix of an order the person's assistant placed through its agent key (agent-orders.ts, J-agents-21 #7). */
export const AGENT_ORDER_PREFIX = 'agent:order:';

/** The origin an order stored under `businessKey` carries: `agent:<keyId>` for the assistant's, else `null` (the person's own). */
export function orderOriginOf(businessKey: string): string | null {
  if (!businessKey.startsWith(AGENT_ORDER_PREFIX)) return null;
  const keyId = businessKey.slice(AGENT_ORDER_PREFIX.length).split(':')[0] ?? '';
  return UUID_RE.test(keyId) ? `agent:${keyId.toLowerCase()}` : null;
}

export const VENUE_WITHDRAW_STEP_UP_SCOPE = 'trade.step_up.venue.withdraw' as const;

/** Identity's step-up request id is at most 128 characters. */
const STEP_UP_REQUEST_ID_MAX = 128;
const BUSINESS_KEY_RE = /^[a-z][a-z0-9.-]*:.+$/;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const ADDRESS_RE = /^0x[0-9a-f]{40}$/;

export type UserVenueDoorCode =
  | 'trade.user_venue_off'
  | 'trade.venue.withdraw_own_wallet_only'
  | 'trade.venue_request_invalid'
  | 'trade.venue_action_key_invalid'
  | 'idempotency.conflict'
  | 'idempotency.in_progress'
  | 'idempotency.key_invalid'
  | 'trade.venue_orders_page_max_unset'
  | 'trade.venue_orders_limit_invalid'
  | 'trade.invalid_cursor'
  | 'trade.venue_builder_fee_changed'
  | 'trade.venue_action_unknown'
  | 'trade.venue.price_outside_protection'
  // A venue market order on a book whose spread is wider than the owner's spread limit (J-cex-spot-03 #2).
  | 'trade.venue.spread_too_wide'
  | 'trade.venue_agent_account_only'
  | 'trade.venue_live_run_only'
  | 'trade.venue_action_other_venue'
  | 'trade.venue_unknown'
  | 'trade.venue_action_key_reserved'
  | 'trade.venue_session_key_reused'
  | 'trade.venue_session_pending'
  | 'trade.venue_session_none'
  | 'trade.venue_session_unavailable'
  | 'trade.venue_session_superseded'
  | 'trade.venue_own_key_misused'
  | 'trade.venue_sub_account_not_own'
  // Convert's venue sell quotes (venue-sell-quotes.ts, J-cex-spot-17 #8).
  | 'trade.venue_sell_quote_unwired'
  | 'trade.venue_sell_quote_market_unknown'
  | 'trade.venue_sell_quote_not_spot'
  | 'trade.venue_sell_quote_key_reused'
  // Our good-till-date (J-cex-spot-03 #7, project-state #2260).
  | 'trade.gtd_expiry_past'
  | 'trade.gtd_owner_signs'
  | 'trade.gtd_after_order'
  | 'trade.gtd_not_due'
  | 'trade.gtd_not_scheduled'
  | VenueRouteRefusalCode;

/**
 * OUR GOOD-TILL-DATE (J-cex-spot-03 #7; Nino's decision on project-state #2260, 13 Nov 2026: "Build good-till-date").
 * The venue offers no good-till-date, so the order goes to the venue good-till-cancelled and our service cancels it at the
 * time the person picked. We hold no key that can cancel on their account, so the cancel is signed by their own wallet
 * BEFORE the order, with the expiry as its nonce (user-venue.ts `sendAt`: the venue's nonce window is relative to when
 * the action lands, so it is valid when we send it at the expiry):
 *
 *   1. prepare `cancel_order` with `sendAt` (stored under `gtd:<clientOrderKey>`): refused if the time has passed
 *      (`trade.gtd_expiry_past`), if an agent key would sign it (`trade.gtd_owner_signs`: a session key can end before
 *      the expiry, and its signature with it), or if that order was already signed (`trade.gtd_after_order`: the cancel
 *      always exists before the order can be sent, so a crash between the two never leaves an order with no expiry);
 *   2. `schedule` stores the wallet's signature and sends nothing;
 *   3. the order is prepared, signed and sent as any order;
 *   4. the sweep (venue-router.ts `sweepGoodTillDate`) sends each due cancel at its time; `submit` refuses it before then
 *      (`trade.gtd_not_due`). A cancel of an order already filled or cancelled is answered by the venue and changes nothing.
 *
 * The venue is the record of the order, its lock and its cancel; the ledger posts nothing.
 */
export interface GoodTillDate {
  readonly actionKey: string;
  readonly clientOrderKey: string;
  readonly venueClientOrderId: string | null;
  readonly symbol: string;
  /** ISO time of the expiry. */
  readonly expiresAt: string;
  /**
   * `scheduled`: before the expiry; `due`: the expiry passed and the cancel is being sent; `expired`: our cancel at the
   * expiry cancelled the order; `not_open`: at the expiry the order was no longer open (filled, cancelled, or never
   * placed), so nothing was cancelled; `failed`: the venue refused the cancel for another reason (`refusal`), and the
   * order may still be open.
   */
  readonly state: 'scheduled' | 'due' | 'expired' | 'not_open' | 'failed';
  readonly refusal: VenueRefusal | null;
  readonly answeredAt: string | null;
}

export interface ScheduledAnswer {
  readonly actionKey: string;
  readonly expiresAt: string;
  /** True when the signature was already stored: nothing changed. */
  readonly replayed: boolean;
}

function sendAtOf(intent: VenueIntent): string | null {
  return intent.kind === 'cancel_order' && typeof intent.sendAt === 'string' ? intent.sendAt : null;
}

/**
 * The trading session's keys (J-wallet-22 #8, D-venue-09; src/venue/session-key.ts): the owner's `approve_agent` for a
 * session key is stored under `session-key:<accountId>:<venueId>:<sessionId>`, and its `revoke_agent` under
 * `session-key-end:` with the same tail. Only the session routes prepare under these keys, so the rule "a new session
 * approves a new key, never one used before" cannot be walked around through the plain prepare route.
 */
export const SESSION_KEY_PREFIX = 'session-key:';
export const SESSION_KEY_END_PREFIX = 'session-key-end:';
const RESERVED_KEY_PREFIXES = [SESSION_KEY_PREFIX, SESSION_KEY_END_PREFIX] as const;

export interface PrepareOptions extends DoorCaller {
  /** Set only by the session routes (session-key.ts): lets the action be stored under a reserved session key. */
  readonly sessionKey?: boolean;
  /**
   * Set only by the signal desk (the alert names its own worst price) and an own agent's order (its worst price is the
   * owner's agent bound, own-agent-trading.ts): the owner's spot protection is not applied.
   */
  readonly ownWorstPrice?: boolean;
}

export class UserVenueDoorError extends Error {
  constructor(
    message: string,
    readonly code: UserVenueDoorCode,
    readonly status: number,
  ) {
    super(message);
    this.name = 'UserVenueDoorError';
  }
}

/** The longest Idempotency-Key header accepted (DV-auth-03). */
export const IDEMPOTENCY_KEY_MAX = 255;
/** How long one request may hold a key's send before another request can take it over (a crashed request). */
const SEND_CLAIM_MS = 30_000;

/**
 * The business key an order sent with an `Idempotency-Key` header is stored and placed under (J-developer-05): the same
 * header always gives the same key, so the venue always sees the same client order id for it and places at most one
 * order. The header is the developer's own API-level key: it is hashed into ours, never used as a ledger key, and the
 * store keeps keys per person, so two people's headers never meet.
 */
export function orderKeyOfIdempotencyKey(header: string | null | undefined): string {
  const k = header ?? '';
  if (k.length < 1 || k.length > IDEMPOTENCY_KEY_MAX || !/^[\x21-\x7e]+$/.test(k)) {
    throw new UserVenueDoorError(
      `the Idempotency-Key must be 1 to ${IDEMPOTENCY_KEY_MAX} visible ASCII characters with no spaces`,
      'idempotency.key_invalid',
      400,
    );
  }
  return `order:api:${createHash('sha256').update(k).digest('hex')}`;
}

/**
 * What we know of one order sent through this door, by its key (J-developer-05 #5). `accepted` carries the venue's
 * record of the order. `unknown` is a send with no definite answer yet: it is never shown as failed or filled, and a
 * retry on the same key re-sends the same signed bytes, so the venue places it at most once. `refused` is the venue's
 * definite refusal; `not_sent` an order prepared and signed nowhere yet.
 */
export interface VenueOrderByKey {
  readonly actionKey: string;
  readonly venueClientOrderId: string | null;
  /** `agent:<keyId>` when the person's assistant placed it through its agent key (shown "by your assistant"), else `null`. */
  readonly origin: string | null;
  readonly state: 'accepted' | 'unknown' | 'refused' | 'not_sent';
  /** Why the state is unknown: the venue did not answer this read, or it has no record of the order yet. */
  readonly reason?: 'venue_down' | 'not_on_venue_yet';
  readonly order: UserVenueOrder | null;
  readonly refusal?: VenueRefusal;
  /** The venue's as-of time of what is shown, or null when the venue was not reached. */
  readonly asOf: Date | null;
}

export interface VenueOrderPage {
  readonly orders: readonly VenueOrderByKey[];
  /** Pass it as `cursor` for the next page; null on the last page. */
  readonly nextCursor: string | null;
}

/** Parse the owner value for the largest page of orders: blank is null (every list refuses); anything else 1 to 1000. */
export function parseOrdersPageMax(raw: string | undefined): number | null {
  const v = (raw ?? '').trim();
  if (v === '') return null;
  if (!/^\d+$/.test(v) || Number(v) < 1 || Number(v) > 1000) {
    throw new Error(`TRADE_USER_VENUE_ORDERS_PAGE_MAX must be a whole number 1 to 1000, got ${JSON.stringify(raw)}`);
  }
  return Number(v);
}

function encodeCursor(row: { createdAt: Date; businessKey: string }): string {
  return Buffer.from(JSON.stringify({ t: row.createdAt.toISOString(), k: row.businessKey })).toString('base64url');
}

function decodeCursor(cursor: string | undefined): { createdAt: Date; businessKey: string } | null {
  if (cursor === undefined || cursor === '') return null;
  try {
    const v = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8')) as { t?: unknown; k?: unknown };
    const at = new Date(typeof v.t === 'string' ? v.t : '');
    if (typeof v.k === 'string' && v.k !== '' && !Number.isNaN(at.getTime())) return { createdAt: at, businessKey: v.k };
  } catch {
    /* refused below */
  }
  throw new UserVenueDoorError('cursor must be the nextCursor of the previous page', 'trade.invalid_cursor', 400);
}

/** The owner values for our builder fee. `null` when either is blank: orders then refuse. */
export interface BuilderFeeValue {
  readonly address: string;
  /** Scaled decimal bps, as `PlaceUserOrderIntent.builderFee.feeBps`. */
  readonly feeBps: Amount;
}

/** Read the two owner values. Both blank, or either blank, is `null`; a set value that is malformed stops the boot. */
export function parseBuilderFee(address: string | undefined, feeBps: string | undefined): BuilderFeeValue | null {
  const a = (address ?? '').trim().toLowerCase();
  const f = (feeBps ?? '').trim();
  if (a === '' || f === '') return null;
  if (!ADDRESS_RE.test(a)) throw new Error(`TRADE_USER_VENUE_BUILDER_ADDRESS must be a 0x address, got ${JSON.stringify(address)}`);
  let fee: Amount;
  try {
    fee = parseAmount(f);
  } catch {
    throw new Error(`TRADE_USER_VENUE_BUILDER_FEE_BPS must be a decimal number of basis points, got ${JSON.stringify(feeBps)}`);
  }
  if (fee < 0n) throw new Error('TRADE_USER_VENUE_BUILDER_FEE_BPS must not be negative');
  return { address: a, feeBps: fee };
}

/** A venue the door reaches, with the chain its actions name and its deposit route when it has one. */
export type ConnectedUserVenue = UserVenue & { readonly chainId?: number; readonly depositRoute?: UserVenueDepositRoute | null };

export interface UserVenueDoorDeps {
  /** Reach the venue. Called until it succeeds; its descriptor is checked against APP_ENV each time it connects. */
  readonly connect: () => Promise<ConnectedUserVenue>;
  /** The RAW `process.env.APP_ENV`. */
  readonly appEnv: string | undefined;
  readonly store: PreparedActionStore;
  readonly stepUp: StepUpCheck;
  readonly builder: BuilderFeeValue | null;
  /**
   * The owner's market price protection in basis points (TRADE_MARKET_SLIPPAGE_CAP_BPS), or null when blank. Every spot
   * market order is checked against it here, on preview and on prepare: blank refuses `trade.slippage_cap_unset`, and a
   * worst price past the bound refuses `trade.venue.price_outside_protection`. Never a default.
   */
  readonly slippageCapBps: number | null;
  /**
   * The owner's spread limit for a spot market order in basis points (TRADE_MARKET_SPREAD_LIMIT_BPS), or null/absent when
   * blank: blank refuses `trade.spread_limit_unset`, and a venue spread wider than it refuses `trade.venue.spread_too_wide`,
   * on preview and on prepare, before anything is prepared. Never a default.
   */
  readonly spreadLimitBps?: number | null;
  /** The builder-fee book of the fee schedule version in force at `at` (null: none, the boot `builder` fee applies). */
  readonly builderFeesAt?: (at: Date) => Promise<BuilderFeeBook | null>;
  readonly now: () => Date;
  /** Our listings, routing states and largest routed orders (J-cex-spot-16). */
  readonly listings: VenueRoutingGate;
  /** Owner value: the largest page of `GET /api/v1/venue/orders`. Null (blank) refuses every list. */
  readonly ordersPageMax?: number | null;
  /**
   * What lowers our builder fee on one person's order (J-campaigns-09 #2 #3): their rank's `feeDiscountBps` (svc-identity)
   * and a fee-saver coupon (svc-campaigns). Absent: every order carries the builder fee in force.
   */
  readonly feeDiscounts?: BuilderFeeDiscounts;
}

/**
 * The two discounts on our builder fee. Each is a fraction OF the fee in basis points (5000 is half of it), never of the
 * venue's fee. `rankBps` answers null when the rank cannot be read (that discount is skipped and logged); `coupons` is
 * null when svc-campaigns is not wired (no coupon is asked for). svc-campaigns unreachable: the whole discount is skipped
 * and logged and the order carries the normal builder fee in force. A discount that cannot be read is never guessed.
 */
export interface BuilderFeeDiscounts {
  readonly rankBps: (userId: string) => Promise<number | null>;
  readonly coupons: FeeSaverSource | null;
  readonly skipped?: (what: 'rank' | 'coupon', userId: string, orderKey: string) => void;
}

/** What priced our builder fee on an order: the winning discount and where it came from (`null`: none applied). */
export type BuilderFeeDiscount =
  | { readonly source: 'coupon'; readonly bps: number; readonly code: string; readonly voucherId: string }
  | { readonly source: 'rank'; readonly bps: number }
  | null;

/** A tenth of a basis point, scaled: the finest builder fee a venue takes (Hyperliquid's `f`). */
const TENTH_BPS = parseAmount('0.1');

/**
 * Our builder fee less `discountBps` of it, floored to a tenth of a basis point: the discount never charges more than it
 * promises, and the venue takes the rate it is given.
 */
export function discountedBuilderFee(feeBps: Amount, discountBps: number): Amount {
  if (!Number.isInteger(discountBps) || discountBps <= 0) return feeBps;
  const off = BigInt(Math.min(discountBps, 10_000));
  const lowered = (feeBps * (10_000n - off)) / 10_000n;
  return lowered - (lowered % TENTH_BPS);
}

/** The owner's spread limit, or `trade.spread_limit_unset` ("protection not set") when blank or not an integer 1–5000. */
export function requireMarketSpreadLimitBps(bps: number | null | undefined): number {
  if (bps == null || !Number.isInteger(bps) || bps < 1 || bps > 5000)
    throw new TradeError(
      'protection not set: the owner spread limit for a market order (TRADE_MARKET_SPREAD_LIMIT_BPS) is unset; place a limit order',
      'trade.spread_limit_unset',
    );
  return bps;
}

/** The venue's best ask is further above its best bid than `limitBps` of the bid. A missing side is never "within". */
export function spreadTooWide(best: Pick<VenueBestPrices, 'bid' | 'ask'>, limitBps: number): boolean {
  if (best.bid === null || best.ask === null || best.bid <= 0n) return false;
  return (best.ask - best.bid) * 10_000n > best.bid * BigInt(limitBps);
}

/**
 * A market order's furthest worst price under the protection: a buy at most the best ask plus `capBps` (rounded up to
 * the tick), a sell at least the best bid less it (rounded down), as the desk's `slippageLimit`. Null with no price.
 */
export function marketProtectionBound(
  side: 'buy' | 'sell',
  best: Pick<VenueBestPrices, 'bid' | 'ask'>,
  capBps: number,
  tick: Amount,
): Amount | null {
  const reference = side === 'buy' ? best.ask : best.bid;
  if (reference === null || reference <= 0n || tick <= 0n) return null;
  const one = 10_000n;
  const ratio = BigInt(capBps);
  const moved = side === 'buy' ? (reference * (one + ratio)) / one : (reference * (one - ratio)) / one;
  const ticks = side === 'buy' ? (moved + tick - 1n) / tick : moved / tick;
  const bound = ticks * tick;
  return bound > 0n ? bound : null;
}

export interface PrepareRequest {
  readonly owner: string;
  readonly subAccount?: string | null;
  readonly signer: VenueSigner;
  readonly intent: VenueIntent;
  /** Required for an intent with no key of its own (amend, approvals, leverage); ignored for an order or a withdrawal. */
  readonly actionKey?: string | null;
  /** Withdrawals: the identity step-up approval id the customer confirmed. */
  readonly stepUpApprovalId?: string | null;
  /**
   * The request's `Idempotency-Key` header (J-developer-05). An order sent with one is stored and placed under
   * `orderKeyOfIdempotencyKey(header)`, which becomes its `clientOrderKey`.
   */
  readonly idempotencyKey?: string | null;
}

export interface PreparedAnswer {
  readonly actionKey: string;
  readonly prepared: PreparedVenueAction;
  /** True when this key was already prepared: this is the stored action, not a new one. */
  readonly reused: boolean;
  readonly signed: boolean;
  readonly lastOutcome: VenueSubmitOutcome | null;
}

export interface SubmitAnswer {
  readonly actionKey: string;
  readonly outcome: VenueSubmitOutcome;
  /** Where to read the action back when `outcome.definite` is false. */
  readonly readBack: { readonly venueClientOrderId: string } | { readonly nonce: string } | null;
  /** True when this is the stored answer of an earlier send: nothing was sent again. */
  readonly replayed: boolean;
}

function invalid(message: string): never {
  throw new UserVenueDoorError(message, 'trade.venue_request_invalid', 400);
}

const SIDES: ReadonlySet<unknown> = new Set(['buy', 'sell']);
const ORDER_TYPES: ReadonlySet<unknown> = new Set(['limit', 'market']);
const TIMES_IN_FORCE: ReadonlySet<unknown> = new Set(['GTC', 'IOC', 'ALO']);
const positive = (v: unknown): boolean => typeof v === 'bigint' && v > 0n;

/**
 * An order intent's own fields, checked before any listing, venue or store read: a malformed one is this door's typed
 * `trade.venue_request_invalid`, never an error thrown deeper in.
 */
function assertPlaceIntent(intent: PlaceUserOrderIntent): void {
  const i = intent as unknown as Record<string, unknown>;
  if (typeof i.symbol !== 'string' || !/^\S{1,64}$/.test(i.symbol)) invalid('symbol must be a venue market symbol');
  if (!SIDES.has(i.side)) invalid('side must be buy or sell');
  if (!ORDER_TYPES.has(i.type)) invalid('type must be limit or market');
  if (!positive(i.amount)) invalid('amount must be a positive decimal string');
  if (!positive(i.price)) invalid('price must be a positive decimal string (on a market order, the worst price accepted)');
  if (!TIMES_IN_FORCE.has(i.timeInForce)) invalid('timeInForce must be GTC, IOC or ALO');
  if (typeof i.reduceOnly !== 'boolean') invalid('reduceOnly must be true or false');
  if (typeof i.clientOrderKey !== 'string') invalid('clientOrderKey must be the business key of this order');
}

/** The wire form with every object's keys sorted: jsonb does not keep key order, so equality never depends on it. */
function canonical(value: unknown): unknown {
  if (value === null || typeof value !== 'object') return value;
  if (Array.isArray(value)) return value.map(canonical);
  const out: Record<string, unknown> = {};
  for (const k of Object.keys(value).sort()) out[k] = canonical((value as Record<string, unknown>)[k]);
  return out;
}

function sameJson(a: unknown, b: unknown): boolean {
  return JSON.stringify(canonical(encodeVenueWire(a))) === JSON.stringify(canonical(encodeVenueWire(b)));
}

/**
 * The signature bytes themselves, checked before the first signature is stored: the prepared typed data must hash to the
 * prepared digest and the bytes must recover to the prepared signer. Bad bytes are refused and never stored, so the key
 * can still complete with a good signature.
 */
async function assertSignatureRecovers(prepared: PreparedVenueAction, signature: VenueSignature): Promise<void> {
  let recovered: string | null = null;
  try {
    const typed = prepared.typedData as TypedDataDefinition;
    if (hashTypedData(typed).toLowerCase() === prepared.digest.toLowerCase()) {
      recovered = (await recoverTypedDataAddress({ ...typed, signature: signature.signature as Hex })).toLowerCase();
    }
  } catch {
    recovered = null;
  }
  if (recovered !== prepared.signer.address.toLowerCase()) {
    throw new VenueRefusalError({
      venueId: prepared.venueId,
      code: 'signature_mismatch',
      detail: 'the signature bytes do not recover to the prepared signer over the prepared payload; nothing was stored or sent',
    });
  }
}

export class UserVenueDoor {
  private venuePromise: Promise<ConnectedUserVenue> | null = null;
  /** The id of the venue this door last connected to; `null` before the first connect. */
  connectedVenueId: string | null = null;

  constructor(private readonly deps: UserVenueDoorDeps) {}

  /** The store and clock the trading-session routes read with (session-key.ts). */
  get sessionDeps(): { readonly store: PreparedActionStore; readonly now: () => Date } {
    return { store: this.deps.store, now: this.deps.now };
  }

  /** The connected venue, checked against APP_ENV. A failed connect is retried on the next call. */
  async venue(): Promise<ConnectedUserVenue> {
    if (!this.venuePromise) {
      this.venuePromise = this.deps.connect().then((v) => {
        refuseTestVenueOutsideTest(v.venue, this.deps.appEnv);
        this.connectedVenueId = v.venue.id;
        return v;
      });
      this.venuePromise.catch(() => {
        this.venuePromise = null;
      });
    }
    return this.venuePromise;
  }

  async status() {
    let venue: ConnectedUserVenue;
    try {
      venue = await this.venue();
    } catch (err) {
      const refusal = err instanceof VenueRefusalError ? err.refusal : null;
      return { enabled: true, available: false, refusal: refusal ?? { code: 'venue_down', detail: (err as Error).message } };
    }
    const test = isTestVenue(venue.venue);
    return {
      enabled: true,
      available: true,
      venue: { id: venue.venue.id, displayName: venue.venue.displayName, proofLevel: venue.venue.proofLevel },
      test,
      ...(test ? { label: 'TEST' } : {}),
      chainId: venue.chainId ?? null,
      // Where the customer's own wallet sends a token to fund this venue account: the customer's transfer, never ours.
      deposit: venue.depositRoute ?? null,
      builder: this.deps.builder ? { address: this.deps.builder.address, feeBps: formatAmount(this.deps.builder.feeBps) } : null,
    };
  }

  async account(owner: string, subAccount?: string | null): Promise<UserVenueAccount> {
    const o = (owner ?? '').trim().toLowerCase();
    if (!ADDRESS_RE.test(o)) invalid('owner must be the wallet address of the venue account (0x and 40 hex)');
    const venue = await this.venue();
    return { venueId: venue.venue.id, owner: o, subAccount: subAccount ?? null };
  }

  /** Each listed market (its kind and tick), read once a minute, so an order costs no extra venue read. */
  private marketList: { at: number; markets: Map<string, UserVenueMarket> } | null = null;

  private async market(venue: UserVenue, symbol: string): Promise<UserVenueMarket> {
    const now = this.deps.now().getTime();
    const fresh = this.marketList && now - this.marketList.at < MARKET_KINDS_TTL_MS ? this.marketList : null;
    let market = fresh?.markets.get(symbol);
    // A miss re-reads the list, so a market listed since the last read is found within seconds, but not more often than
    // once per MARKET_MISS_REREAD_MS: inside that, an unlisted symbol is refused from the list just read.
    const justRead = fresh !== null && now - fresh.at < MARKET_MISS_REREAD_MS;
    if (!market && !justRead) {
      const markets = new Map((await venue.markets(null)).value.map((m) => [m.symbol, m] as const));
      this.marketList = { at: now, markets };
      market = markets.get(symbol);
    }
    if (!market) {
      throw new VenueRefusalError({ venueId: venue.venue.id, code: 'unknown_market', detail: `${symbol} is not listed on this venue` });
    }
    return market;
  }

  private async marketKind(venue: UserVenue, symbol: string): Promise<'spot' | 'perpetual'> {
    return (await this.market(venue, symbol)).kind;
  }

  /** The worst price `assertMarketProtection` allows a market order on `symbol`, with its refusals (Convert's quote). */
  async marketWorstPrice(symbol: string, side: 'buy' | 'sell'): Promise<Amount> {
    const venue = await this.venue();
    const cap = requireMarketSlippageCapBps(this.deps.slippageCapBps);
    const market = await this.market(venue, symbol);
    const best = venue.bestPrices ? (await venue.bestPrices(symbol)).value : null;
    const bound = best ? marketProtectionBound(side, best, cap, market.tickSize) : null;
    if (bound === null) {
      throw new TradeError(
        `${symbol} has no ${side === 'buy' ? 'ask' : 'bid'} on the venue to bound a market ${side} by the price protection; place a limit order`,
        'trade.no_reference_price',
      );
    }
    return bound;
  }

  /**
   * A market order is bounded by the owner's price protection, here and not only in the browser: blank refuses
   * `trade.slippage_cap_unset`; no best price on the side it meets refuses `trade.no_reference_price` (never an
   * unbounded order); a worst price past the bound refuses `trade.venue.price_outside_protection`. A limit order is
   * not touched. Spot only: a perpetual's market order carries the futures ticket's own typed worst price.
   */
  private async assertMarketProtection(venue: UserVenue, intent: PlaceUserOrderIntent): Promise<void> {
    if (intent.type !== 'market') return;
    const market = await this.market(venue, intent.symbol);
    if (market.kind !== 'spot') return;
    const cap = requireMarketSlippageCapBps(this.deps.slippageCapBps);
    const spreadLimit = requireMarketSpreadLimitBps(this.deps.spreadLimitBps);
    if (typeof intent.price !== 'bigint') invalid('a market order carries its worst price as a decimal string');
    const best = venue.bestPrices ? (await venue.bestPrices(intent.symbol)).value : null;
    if (best && spreadTooWide(best, spreadLimit)) {
      throw new UserVenueDoorError(
        `the venue's spread on ${intent.symbol} (bid ${formatAmount(best.bid!)}, ask ${formatAmount(best.ask!)}) is wider than the owner's spread limit of ${spreadLimit} bps; no market order is prepared, place a limit order`,
        'trade.venue.spread_too_wide',
        422,
      );
    }
    const bound = best ? marketProtectionBound(intent.side, best, cap, market.tickSize) : null;
    if (bound === null) {
      throw new TradeError(
        `${intent.symbol} has no ${intent.side === 'buy' ? 'ask' : 'bid'} on the venue to bound a market ${intent.side} by the price protection; place a limit order`,
        'trade.no_reference_price',
      );
    }
    const outside = intent.side === 'buy' ? intent.price > bound : intent.price < bound;
    if (outside) {
      throw new UserVenueDoorError(
        `a market ${intent.side} at ${formatAmount(intent.price)} is past the owner's price protection (${intent.side === 'buy' ? 'at most' : 'at least'} ${formatAmount(bound)}, ${cap} bps from the venue's best ${intent.side === 'buy' ? 'ask' : 'bid'}); nothing was prepared`,
        'trade.venue.price_outside_protection',
        422,
      );
    }
  }

  /** Our builder address on the venue: the owner value, or null when it is blank. */
  private builderAddress(): string | null {
    return this.deps.builder?.address ?? null;
  }

  /**
   * Our builder fee on an order: the builder-fee version in force now for its venue and market group, else the boot
   * owner value; blank refuses before the venue is asked to prepare. A spot buy carries none and so never needs it
   * published or approved: the venue charges builder fees only on a spot sell and on both sides of a perp ("builder
   * codes do not apply to the buying side of spot trades", Hyperliquid's builder-codes page, read 9 Nov 2026;
   * project-state #1888).
   */
  private async withBuilderFee(venue: UserVenue, intent: PlaceUserOrderIntent): Promise<PlaceUserOrderIntent> {
    const kind = await this.marketKind(venue, intent.symbol);
    if (kind === 'spot' && intent.side === 'buy') return { ...intent, builderFee: null };
    const venueId = venue.venue.id;
    const address = this.builderAddress();
    let feeBps: Amount | null = this.deps.builder?.feeBps ?? null;
    try {
      const versioned = builderFeeOf((await this.deps.builderFeesAt?.(this.deps.now())) ?? null, venueId, intent?.symbol ?? '');
      if (versioned) feeBps = versioned.feeBps;
    } catch (err) {
      if (!(err instanceof BuilderFeeVersionError)) throw err;
      // A stored builder-fee version this door cannot read is never replaced by a guess: no order is prepared.
      throw new VenueRefusalError({
        venueId,
        code: 'builder_fee_not_published',
        detail: `the builder-fee version in force cannot be read (${err.code}: ${err.message}), so no order is prepared`,
      });
    }
    if (!address || feeBps === null) {
      throw new VenueRefusalError({
        venueId: venue.venue.id,
        code: 'builder_fee_not_published',
        detail: 'our builder fee is not published (owner value blank), so no order is prepared',
      });
    }
    return { ...intent, builderFee: { builder: address, feeBps } };
  }

  /**
   * Our builder fee on an order of `side` on `symbol` here: `{ carries: false }` for a spot buy, the fee in force when it
   * carries one, or `null` when the owner value is blank (or the version in force can't be read). The venues strip and the
   * route preview read it; an order is still priced by `withBuilderFee` at prepare.
   */
  async builderFeeFor(symbol: string, side: 'buy' | 'sell'): Promise<{ carries: false } | { carries: true; feeBps: Amount } | null> {
    const venue = await this.venue();
    try {
      const priced = await this.withBuilderFee(venue, {
        kind: 'place_order',
        symbol,
        side,
        type: 'limit',
        amount: 1n,
        price: 1n,
        timeInForce: 'GTC',
        reduceOnly: false,
        clientOrderKey: 'order:builder-fee-read',
        builderFee: null,
      });
      return priced.builderFee ? { carries: true, feeBps: priced.builderFee.feeBps } : { carries: false };
    } catch (err) {
      if (err instanceof VenueRefusalError && err.refusal.code === 'builder_fee_not_published') return null;
      throw err;
    }
  }

  /**
   * J-derivatives-01 #2: every perpetual we show here, open or blocked for this account with every reason. `account` is
   * the region and level gate's reason, or null. A read: nothing is prepared or sent.
   */
  async gatedList(account: VenueGatedBlocker | null): Promise<{ venueId: string; value: VenueGatedContract[]; asOf: Date }> {
    const venue = await this.venue();
    const read = await this.markets();
    const perps = read.value.filter((m) => m.kind === 'perpetual');
    const published = new Map<string, boolean>();
    for (const m of perps) published.set(m.symbol, (await this.builderFeeFor(m.symbol, 'buy')) !== null);
    const value = venueGatedList({
      markets: perps,
      account,
      builderFeePublished: (symbol) => published.get(symbol) === true,
      venueName: venue.venue.displayName,
    });
    return { venueId: venue.venue.id, value, asOf: this.deps.now() };
  }

  /** The venue's markets we show (an approved listing), each with our listing beside the venue's own state. */
  async markets() {
    const venue = await this.venue();
    const read = await venue.markets(null);
    const shown = await this.deps.listings.shown(venue.venue.id, this.deps.now());
    const value: ListedVenueMarket[] = [];
    for (const m of read.value) {
      const listing = shown.get(m.symbol);
      if (listing) value.push({ ...m, listing });
    }
    return { ...read, value };
  }

  /**
   * The funding the venue published since `since` on the listed perpetual whose base asset is `base` (J-charts-desk-04 #6:
   * a spot chart's funding study reads its asset's perpetual). Refuses `not_offered` when we list no perpetual on that
   * asset or the venue (or its adapter) publishes no funding history; the venue's own refusals pass through.
   */
  async fundingHistory(base: string, since: Date) {
    const venue = await this.venue();
    const wanted = base.toUpperCase();
    const perp = (await this.markets()).value.find((m) => m.kind === 'perpetual' && m.baseAsset.toUpperCase() === wanted);
    if (!perp)
      throw new VenueRefusalError({
        venueId: venue.venue.id,
        code: 'not_offered',
        detail: `no perpetual on ${wanted} is listed on this venue`,
      });
    if (!venue.fundingHistory)
      throw new VenueRefusalError({ venueId: venue.venue.id, code: 'not_offered', detail: `this venue publishes no funding history` });
    const read = await venue.fundingHistory(perp.symbol, since);
    return {
      ...read,
      symbol: perp.symbol,
      intervalSeconds: perp.funding.known ? perp.funding.value.intervalSeconds : null,
      test: isTestVenue(venue.venue),
    };
  }

  /** A new order our listing, routing state, dates or largest order refuse, as this door's typed refusal. */
  private async admitPlace(venueId: string, intent: PlaceUserOrderIntent): Promise<void> {
    try {
      await this.deps.listings.admitPlace(venueId, intent, this.deps.now());
    } catch (err) {
      if (err instanceof VenueRouteRefusal) throw new UserVenueDoorError(err.message, err.code, 422);
      throw err;
    }
  }

  async preview(principal: Principal, owner: string, intent: VenueIntent) {
    if (intent?.kind !== 'place_order') invalid('preview takes an order intent (kind place_order)');
    assertPlaceIntent(intent);
    const venue = await this.venue();
    // The same order as prepare: the venue's own market list first (a symbol it does not list is its `unknown_market`),
    // then our builder fee, then our listing, routing state, dates and largest order.
    const withFee = await this.withBuilderFee(venue, intent);
    await this.admitPlace(venue.venue.id, withFee);
    // The winning discount as it stands: a coupon is named, never taken, by a preview.
    const { intent: priced, discount } = await this.withFeeDiscount(principal, withFee, intent.clientOrderKey, 'quote');
    const account = await this.account(owner);
    await this.assertMarketProtection(venue, withFee);
    const answered = await venue.preview(account, priced);
    return { ...answered, value: { ...answered.value, feeDiscount: discount } };
  }

  /**
   * Our builder fee on `intent` less the winning discount (J-campaigns-09 #2 #3): the larger of the person's rank discount
   * and their best fee-saver coupon, never both. `quote` names the coupon and takes nothing; `take` takes one use of it for
   * this order key, only when it beats the rank, once (the same key again is the same use); `read` reprices a stored
   * order with the use it already took. No coupon: the rank's rate. svc-campaigns down (or unwired with none answered):
   * the winning rate cannot be known, so the discount is skipped and logged and the order carries the normal builder fee
   * in force ("if the campaigns service is down the order carries the normal builder fee", J-campaigns-09 #2).
   */
  private async withFeeDiscount(
    principal: Principal,
    intent: PlaceUserOrderIntent,
    orderKey: string,
    mode: 'quote' | 'take' | 'read',
  ): Promise<{ intent: PlaceUserOrderIntent; discount: BuilderFeeDiscount }> {
    const d = this.deps.feeDiscounts;
    if (!d || !intent.builderFee) return { intent, discount: null };
    const rank = await d.rankBps(principal.userId).catch(() => null);
    if (rank === null) d.skipped?.('rank', principal.userId, orderKey);
    const rankBps = rank ?? 0;
    let coupon = null as Awaited<ReturnType<FeeSaverSource['ask']>>;
    if (d.coupons) {
      const ask = mode === 'take' ? 'quote' : mode;
      coupon = await d.coupons.ask(principal.userId, orderKey, ask);
      // A coupon that beats the rank is taken for this order; one that does not is left for another.
      if (mode === 'take' && coupon && coupon.discountBps > rankBps) coupon = await d.coupons.ask(principal.userId, orderKey, 'take');
      if (coupon === undefined) {
        d.skipped?.('coupon', principal.userId, orderKey);
        return { intent, discount: null };
      }
    }
    let discount: BuilderFeeDiscount = rankBps > 0 ? { source: 'rank', bps: rankBps } : null;
    if (coupon && coupon.discountBps > rankBps) {
      discount = { source: 'coupon', bps: coupon.discountBps, code: coupon.code, voucherId: coupon.voucherId };
    }
    if (!discount) return { intent, discount };
    const feeBps = discountedBuilderFee(intent.builderFee.feeBps, discount.bps);
    return { intent: { ...intent, builderFee: { ...intent.builderFee, feeBps } }, discount };
  }

  /** The key the action is stored under: the intent's own business key where it has one. */
  private businessKey(intent: VenueIntent, actionKey: string | null | undefined): string {
    let key: string | null | undefined;
    if (intent.kind === 'place_order') key = intent.clientOrderKey;
    else if (intent.kind === 'withdraw') key = intent.withdrawalKey;
    else if (intent.kind === 'cancel_order')
      key = intent.sendAt != null ? `${GTD_KEY_PREFIX}${intent.clientOrderKey}` : (actionKey ?? `cancel:${intent.clientOrderKey}`);
    else if (intent.kind === 'sub_account_transfer' || intent.kind === 'market_margin_transfer') key = intent.moveKey;
    else if (intent.kind === 'create_sub_account') key = intent.subAccountKey;
    else key = actionKey;
    const k = (key ?? '').trim();
    if (k.length < 3 || k.length > 200 || UUID_RE.test(k) || !BUSINESS_KEY_RE.test(k)) {
      throw new UserVenueDoorError(
        `the action key ${JSON.stringify(key ?? null)} is not a business key ("<kind>:<owner>:<intent>", never a random id)`,
        'trade.venue_action_key_invalid',
        400,
      );
    }
    return k;
  }

  async prepare(principal: Principal, req: PrepareRequest, opts: PrepareOptions = {}): Promise<PreparedAnswer> {
    let intent = req.intent;
    if (!intent || typeof intent !== 'object' || typeof intent.kind !== 'string') invalid('intent is required');
    if (req.idempotencyKey !== undefined && req.idempotencyKey !== null) {
      if (intent.kind !== 'place_order') invalid('an Idempotency-Key is taken on an order (kind place_order)');
      const key = orderKeyOfIdempotencyKey(req.idempotencyKey);
      const given = (intent as { clientOrderKey?: unknown }).clientOrderKey;
      if (given !== undefined && given !== null && given !== '' && given !== key) {
        invalid('with an Idempotency-Key, leave clientOrderKey out: the order is placed under the key the header names');
      }
      intent = { ...intent, clientOrderKey: key };
    }
    const caller: DoorCaller = opts;
    if (
      !req.signer ||
      (req.signer.role !== 'owner' && req.signer.role !== 'agent') ||
      !ADDRESS_RE.test(req.signer.address?.toLowerCase() ?? '')
    ) {
      invalid('signer must be { role: owner|agent, address: 0x... }');
    }
    assertInteractive(principal, intent.kind);
    assertTradingLevel(principal, intent.kind);
    assertOwnWalletWithdrawal(principal, req.owner, intent);
    if (intent.kind === 'place_order') assertPlaceIntent(intent);
    const key = this.businessKey(intent, req.actionKey);
    assertDoorMay(intent.kind, caller, key);
    assertLiveRunKey(key, caller);
    // The person's own sub-account keys are for its two intents only, never another action's.
    if (key.startsWith('own:') && !isOwnSubAccountKey(intent.kind, key)) {
      throw new UserVenueDoorError(
        `the key ${key} is for opening your own sub-account (${OWN_SUB_ACCOUNT_PREFIX}) or moving into or out of it (${OWN_MOVE_PREFIX})`,
        'trade.venue_own_key_misused',
        400,
      );
    }
    // The agent account's keys (`agent:account:...`, `agent:move:...`) are its own: the plain door never stores an action
    // under one, so the agent account reads back only what it prepared.
    if (key.startsWith('agent:') && !caller?.agentAccount) {
      throw new UserVenueDoorError(`the key ${key} belongs to the agent account`, 'trade.venue_agent_account_only', 403);
    }
    if (!opts.sessionKey && RESERVED_KEY_PREFIXES.some((prefix) => key.startsWith(prefix))) {
      throw new UserVenueDoorError(
        `the action key ${JSON.stringify(key)} belongs to the trading session's own routes (/api/v1/venue/session/...)`,
        'trade.venue_action_key_reserved',
        409,
      );
    }
    if (key.startsWith(GTD_KEY_PREFIX) !== (sendAtOf(intent) !== null)) {
      throw new UserVenueDoorError(
        `the key prefix ${GTD_KEY_PREFIX} is for a good-till-date's cancel (cancel_order with sendAt) only`,
        'trade.venue_action_key_reserved',
        409,
      );
    }
    if (intent.kind === 'cancel_order' && intent.sendAt != null) await this.assertGoodTillDate(principal, req.signer, intent);
    // An agent key (a session key) never signs a withdrawal or an approval: refused here, before a step-up is spent or
    // the venue is asked, as the venue would refuse it (user-venue.ts `assertSignerMaySign`).
    if (req.signer.role === 'agent' && OWNER_ONLY_INTENTS.has(intent.kind)) {
      throw new VenueRefusalError({
        venueId: (await this.venue()).venue.id,
        code: 'agent_not_permitted',
        detail: `an agent key cannot sign ${intent.kind}; only the account owner's wallet can`,
      });
    }
    // An agent key is approved once, under one business key, and never again, on any venue account and by any route,
    // the session routes included (user-venue.ts:177-180: a venue that prunes nonces could accept a replay of an old
    // key's actions). The same key asked again is the same stored approval (`reuse` below), never a second one.
    if (intent.kind === 'approve_agent') {
      const address = (intent.agentAddress ?? '').toLowerCase();
      const earlier = await this.deps.store.agentApprovals(principal.userId, address);
      if (earlier.some((row) => row.businessKey !== key)) {
        throw new UserVenueDoorError(
          `${address} was approved as an agent before; a key is approved once and never again`,
          'trade.venue_session_key_reused',
          409,
        );
      }
    }

    // A withdrawal spends identity's step-up first: nothing is read, prepared or stored before it passes.
    if (intent.kind === 'withdraw') {
      const requestId = `venue.withdraw:${key}`;
      if (requestId.length > STEP_UP_REQUEST_ID_MAX) {
        throw new UserVenueDoorError('the withdrawal key is too long for a confirmation', 'trade.venue_action_key_invalid', 400);
      }
      if (typeof intent.amount !== 'bigint') invalid('the withdrawal amount must be a decimal string');
      await this.deps.stepUp.require({
        scope: VENUE_WITHDRAW_STEP_UP_SCOPE,
        userId: principal.userId,
        sessionId: principal.sid,
        approvalId: req.stepUpApprovalId,
        fields: {
          withdrawalKey: key,
          // The venue account the funds leave: a step-up proves the account as well as the amount and destination.
          owner: (req.owner ?? '').trim().toLowerCase(),
          subAccount: req.subAccount ?? '',
          asset: intent.asset,
          amount: formatAmount(intent.amount),
          destination: (intent.destination ?? '').toLowerCase(),
        },
        requestId,
      });
    }

    const venue = await this.venue();
    const account = await this.account(req.owner, req.subAccount);
    const signer: VenueSigner = { role: req.signer.role, address: req.signer.address.toLowerCase() };
    let finalIntent: VenueIntent = intent;
    if (intent.kind === 'place_order') finalIntent = await this.withBuilderFee(venue, intent);
    if (intent.kind === 'approve_builder_fee') {
      const builder = this.builderAddress();
      if (!builder) {
        throw new VenueRefusalError({
          venueId: venue.venue.id,
          code: 'builder_fee_not_published',
          detail: 'our builder is not published (owner value blank)',
        });
      }
      if (intent.builder.toLowerCase() !== builder) invalid(`the builder to approve is ours, ${builder}`);
    }

    const existing = await this.deps.store.find(principal.userId, key);
    if (existing) {
      // A stored order is repriced with the coupon use it already took, never a new one.
      if (finalIntent.kind === 'place_order') finalIntent = (await this.withFeeDiscount(principal, finalIntent, key, 'read')).intent;
      return this.reuse(existing, account, signer, finalIntent);
    }
    if (finalIntent.kind === 'sub_account_transfer' && key.startsWith(OWN_MOVE_PREFIX)) {
      await this.assertOwnSubAccount(principal, venue, account, finalIntent.subAccount);
    }
    if (finalIntent.kind === 'place_order') await this.admitPlace(venue.venue.id, finalIntent);

    // A new market order is bounded before the venue is asked to prepare it. A stored one was bounded when it was
    // prepared, and its retry returns those same bytes, so a moved book never changes the intent sent for a key.
    if (finalIntent.kind === 'place_order' && !opts.ownWorstPrice) await this.assertMarketProtection(venue, finalIntent);
    // Only an order every check admitted takes a coupon. It keeps the builder fee it is signed with: a coupon used up
    // later never reprices it (J-campaigns-09 #3).
    if (finalIntent.kind === 'place_order') finalIntent = (await this.withFeeDiscount(principal, finalIntent, key, 'take')).intent;

    const prepared = await venue.prepare(account, signer, finalIntent);
    const stored = await this.deps.store.insertOnce(principal.userId, key, prepared, this.deps.now());
    // A concurrent prepare of the same key may have won the insert: the stored action is the one.
    if (stored.prepared.digest !== prepared.digest) return this.reuse(stored, account, signer, finalIntent);
    return { actionKey: key, prepared: stored.prepared, reused: false, signed: false, lastOutcome: null };
  }

  /**
   * The sub-accounts this person opened as their own on `account` (the main account): each `own:sub-account:` action the
   * venue accepted, by the id it answered, or, for one whose answer was lost, the venue's own sub-account of that name.
   */
  async ownSubAccounts(principal: Principal, account: UserVenueAccount): Promise<ReadonlySet<string>> {
    const rows = await this.deps.store.listByPrefix(principal.userId, OWN_SUB_ACCOUNT_PREFIX);
    const mine = rows.filter(
      (r) =>
        r.prepared.intent.kind === 'create_sub_account' &&
        r.prepared.venueId === account.venueId &&
        r.prepared.account.owner.toLowerCase() === account.owner &&
        r.signature !== null,
    );
    const own = new Set<string>();
    const unanswered = new Set<string>();
    for (const r of mine) {
      const o = r.lastOutcome;
      if (o?.definite && o.accepted && o.venueRef) own.add(o.venueRef.toLowerCase());
      else if (!o?.definite && r.prepared.intent.kind === 'create_sub_account') unanswered.add(r.prepared.intent.name.trim());
    }
    if (unanswered.size > 0) {
      const venue = await this.venue();
      if (hasSubAccountReads(venue)) {
        for (const sub of (await venue.subAccounts(account)).value)
          if (unanswered.has(sub.name.trim())) own.add(sub.subAccount.toLowerCase());
      }
    }
    return own;
  }

  /** A move under an `own:move:` key reaches only a sub-account this person opened as their own, never an agent account. */
  private async assertOwnSubAccount(principal: Principal, venue: UserVenue, account: UserVenueAccount, subAccount: unknown) {
    const id = typeof subAccount === 'string' ? subAccount.trim().toLowerCase() : '';
    if (id === '') invalid('subAccount is the venue id of the sub-account to move into or out of');
    if (account.subAccount !== null) invalid('a move between your accounts is signed on your main account: send no subAccount');
    if (!(await this.ownSubAccounts(principal, account)).has(id)) {
      throw new UserVenueDoorError(
        `${id} is not a sub-account you opened as your own on ${venue.venue.displayName}; an agent account is funded from its own page, under its cap`,
        'trade.venue_sub_account_not_own',
        403,
      );
    }
  }

  private reuse(row: StoredVenueAction, account: UserVenueAccount, signer: VenueSigner, intent: VenueIntent): PreparedAnswer {
    const p = row.prepared;
    if (
      p.intent.kind === 'place_order' &&
      intent.kind === 'place_order' &&
      sameJson(p.account, account) &&
      sameJson(p.signer, signer) &&
      sameJson({ ...p.intent, builderFee: null }, { ...intent, builderFee: null }) &&
      !sameJson(p.intent.builderFee, intent.builderFee)
    ) {
      throw new UserVenueDoorError(
        `our builder fee changed since ${row.businessKey} was prepared; the stored order keeps the fee it was prepared with, so a new order needs a new key`,
        'trade.venue_builder_fee_changed',
        409,
      );
    }
    if (!sameJson(p.account, account) || !sameJson(p.signer, signer) || !sameJson(p.intent, intent)) {
      throw new UserVenueDoorError(
        `the key ${row.businessKey} was already used for a different action; a new action needs a new key`,
        'idempotency.conflict',
        409,
      );
    }
    return { actionKey: row.businessKey, prepared: p, reused: true, signed: row.signature !== null, lastOutcome: row.lastOutcome };
  }

  /**
   * Send the stored action with its stored signature. The first signature given is stored before anything is sent and
   * is the one every re-submit re-sends. A signature that does not claim the stored digest and signer, or whose bytes do
   * not recover to the prepared signer, is refused before it is stored; the venue verifies the bytes again.
   */
  /** The stored action under `actionKey`, or `null`: what the agent account reads back its own actions by. */
  async stored(principal: Principal, actionKey: string): Promise<StoredVenueAction | null> {
    return this.deps.store.find(principal.userId, actionKey);
  }

  /** Every stored action of this person under keys starting `prefix`: what a revoke reads the assistant's orders by (#12). */
  async storedByPrefix(principal: Principal, prefix: string): Promise<readonly StoredVenueAction[]> {
    return this.deps.store.listByPrefix(principal.userId, prefix);
  }

  async submit(principal: Principal, actionKey: string, signature: VenueSignature, caller?: DoorCaller): Promise<SubmitAnswer> {
    const key = (actionKey ?? '').trim();
    const row = await this.deps.store.find(principal.userId, key);
    if (!row)
      throw new UserVenueDoorError(`no prepared action under ${JSON.stringify(key)}: prepare it first`, 'trade.venue_action_unknown', 404);
    assertDoorMay(row.prepared.intent.kind, caller, key);
    assertLiveRunKey(key, caller);
    assertInteractive(principal, row.prepared.intent.kind);
    const sendAt = sendAtOf(row.prepared.intent);
    if (sendAt !== null && Number(sendAt) > this.deps.now().getTime()) {
      throw new UserVenueDoorError(
        `${key} is sent by our service at the expiry, ${new Date(Number(sendAt)).toISOString()}; nothing was sent`,
        'trade.gtd_not_due',
        409,
      );
    }
    // An action is only ever sent to the venue it was prepared for: with several venues behind the router, a key stored
    // for another venue is that venue's door's to send (venue-router.ts), never this one's.
    // The id last connected, never a fresh connect: a venue down now still answers a signed key with its read-back below.
    const here = this.connectedVenueId;
    if (here !== null && row.prepared.venueId !== here) {
      throw new UserVenueDoorError(
        `${key} was prepared for ${row.prepared.venueId}, not ${here}; it is sent only to the venue it was prepared for`,
        'trade.venue_action_other_venue',
        409,
      );
    }
    // A trading session's approval that was never signed, and that a later session of the same sign-in on the same venue
    // account has replaced, is abandoned: it is never signed and sent later (a stale tab), where it would take the newer
    // session's slot. A later session on another wallet takes no slot of this one's.
    if (!row.signature && key.startsWith(SESSION_KEY_PREFIX)) {
      const m = /^(.*\.)(\d+)$/.exec(key);
      const later = m
        ? (await this.deps.store.listByPrefix(principal.userId, m[1]!)).some((r) => {
            const n = /\.(\d+)$/.exec(r.businessKey)?.[1];
            return (
              n !== undefined &&
              r.businessKey.slice(0, -n.length) === m[1] &&
              Number(n) > Number(m[2]) &&
              r.prepared.account.owner.toLowerCase() === row.prepared.account.owner.toLowerCase()
            );
          })
        : false;
      if (later) {
        throw new UserVenueDoorError(
          'a newer trading session was started in this sign-in, so this approval is no longer asked for; nothing was sent',
          'trade.venue_session_superseded',
          409,
        );
      }
    }
    if (
      !signature ||
      typeof signature.signature !== 'string' ||
      typeof signature.digest !== 'string' ||
      typeof signature.signedBy !== 'string'
    ) {
      invalid('signature must be { digest, signature, signedBy }');
    }
    // A definite answer is already recorded: the same stored bytes are sent again (the venue answers its first answer, and
    // a lost or "already used" answer never replaces the recorded one), and the answer is marked as the stored response.
    const replayed = row.signature !== null && row.lastOutcome?.definite === true;
    // One request sends a key at a time: a second one at the same moment is told to retry, never raced to the venue.
    const at = this.deps.now();
    if (!(await this.deps.store.claimSend(principal.userId, key, at, new Date(at.getTime() + SEND_CLAIM_MS)))) {
      throw new UserVenueDoorError(
        `another request with the key ${key} is being sent to the venue now; retry once it has answered`,
        'idempotency.in_progress',
        409,
      );
    }
    try {
      return { ...(await this.send(principal.userId, key, row, signature)), replayed };
    } finally {
      await this.deps.store.releaseSend(principal.userId, key);
    }
  }

  private async send(
    userId: string,
    key: string,
    row: StoredVenueAction,
    signature: VenueSignature,
  ): Promise<Omit<SubmitAnswer, 'replayed'>> {
    let signed = row;
    // An order never sent yet is checked again: a stop or limit approved since it was prepared applies to it.
    if (!row.signature && row.prepared.intent.kind === 'place_order') await this.admitPlace(row.prepared.venueId, row.prepared.intent);
    if (!row.signature) {
      assertSignatureMatches(row.prepared, signature);
      await assertSignatureRecovers(row.prepared, signature);
      signed = await this.deps.store.signOnce(userId, key, signature, this.deps.now());
    }
    const p = signed.prepared;
    const readBackOf = (o: VenueSubmitOutcome) =>
      o.definite ? null : p.venueClientOrderId ? { venueClientOrderId: p.venueClientOrderId } : { nonce: p.nonce };
    let answered: VenueSubmitOutcome;
    try {
      const venue = await this.venue();
      answered = await venue.submit(signed.prepared, signed.signature as VenueSignature);
    } catch (error) {
      // The venue is down for this attempt. If these bytes were already sent once, the action may be live: answer with
      // what is recorded (or "not definite") and the read-back, never a bare refusal that invites a new key.
      const down = error instanceof VenueRefusalError && error.refusal.code === 'venue_down';
      if (down && row.signature) {
        const outcome: VenueSubmitOutcome = row.lastOutcome ?? { definite: false, reason: 'connection_lost' };
        return { actionKey: key, outcome, readBack: readBackOf(outcome) };
      }
      throw error;
    }
    // A definite outcome already recorded is never replaced by a not-definite one: that is the answer.
    const outcome = await this.deps.store.recordOutcome(userId, key, answered, this.deps.now());
    return { actionKey: key, outcome, readBack: readBackOf(outcome) };
  }

  private async assertGoodTillDate(principal: Principal, signer: VenueSigner, intent: VenueIntent & { kind: 'cancel_order' }) {
    const sendAt = intent.sendAt ?? '';
    if (!SEND_AT_RE.test(sendAt)) invalid('sendAt is the expiry in epoch milliseconds');
    if (Number(sendAt) <= this.deps.now().getTime()) {
      throw new UserVenueDoorError('the expiry has already passed, so nothing is signed or sent', 'trade.gtd_expiry_past', 400);
    }
    if (signer.role !== 'owner') {
      throw new UserVenueDoorError(
        "a good-till-date's cancel is signed by your wallet, not a session key, so it stays valid if the session ends before the expiry",
        'trade.gtd_owner_signs',
        403,
      );
    }
    const order = await this.deps.store.find(principal.userId, intent.clientOrderKey);
    if (order?.signature) {
      throw new UserVenueDoorError(
        `the order ${intent.clientOrderKey} was already signed; its expiry is signed before the order, never after`,
        'trade.gtd_after_order',
        409,
      );
    }
  }

  /**
   * Store the wallet's signature of a good-till-date's cancel and send nothing: our service sends it at the expiry. The
   * same signature again is the stored answer. An expiry that has passed by now is refused and nothing is stored.
   */
  async schedule(principal: Principal, actionKey: string, signature: VenueSignature): Promise<ScheduledAnswer> {
    const key = (actionKey ?? '').trim();
    const row = await this.deps.store.find(principal.userId, key);
    const sendAt = row ? sendAtOf(row.prepared.intent) : null;
    if (!row || sendAt === null || !key.startsWith(GTD_KEY_PREFIX)) {
      throw new UserVenueDoorError(
        `no good-till-date cancel under ${JSON.stringify(key)}: prepare it first`,
        'trade.gtd_not_scheduled',
        404,
      );
    }
    const expiresAt = new Date(Number(sendAt)).toISOString();
    if (row.signature) return { actionKey: key, expiresAt, replayed: true };
    if (Number(sendAt) <= this.deps.now().getTime()) {
      throw new UserVenueDoorError('the expiry has already passed, so nothing is signed or sent', 'trade.gtd_expiry_past', 400);
    }
    if (
      !signature ||
      typeof signature.signature !== 'string' ||
      typeof signature.digest !== 'string' ||
      typeof signature.signedBy !== 'string'
    ) {
      invalid('signature must be { digest, signature, signedBy }');
    }
    assertSignatureMatches(row.prepared, signature);
    await assertSignatureRecovers(row.prepared, signature);
    await this.deps.store.signOnce(principal.userId, key, signature, this.deps.now());
    return { actionKey: key, expiresAt, replayed: false };
  }

  /**
   * Send one due good-till-date cancel the sweep found (venue-router.ts), on this door's venue. Held by the send claim, so
   * a person's own submit at the same moment never races it. Returns false when another request holds the claim.
   */
  async sendDueGoodTillDate(row: StoredVenueAction): Promise<boolean> {
    const at = this.deps.now();
    const sendAt = sendAtOf(row.prepared.intent);
    if (!row.signature || sendAt === null || Number(sendAt) > at.getTime()) return false;
    if (!(await this.deps.store.claimSend(row.userId, row.businessKey, at, new Date(at.getTime() + SEND_CLAIM_MS)))) return false;
    try {
      await this.send(row.userId, row.businessKey, row, row.signature);
      return true;
    } catch (err) {
      // The venue refused the signed cancel before applying it (a refusal, not an outage): that is its definite answer,
      // recorded so the person sees it (`failed`) and it is not sent again every sweep.
      if (err instanceof VenueRefusalError && err.refusal.code !== 'venue_down') {
        await this.deps.store.recordOutcome(
          row.userId,
          row.businessKey,
          { definite: true, accepted: false, refusal: err.refusal, asOf: this.deps.now() },
          this.deps.now(),
        );
        return true;
      }
      throw err;
    } finally {
      await this.deps.store.releaseSend(row.userId, row.businessKey);
    }
  }

  /** This person's good-till-date orders on one venue account, newest expiry first: each expiry and what became of it. */
  async goodTillDates(principal: Principal, owner: string): Promise<readonly GoodTillDate[]> {
    const account = await this.account(owner);
    const now = this.deps.now().getTime();
    const rows = await this.deps.store.listByPrefix(principal.userId, GTD_KEY_PREFIX);
    const out: GoodTillDate[] = [];
    for (const row of rows) {
      const p = row.prepared;
      const sendAt = sendAtOf(p.intent);
      if (!row.signature || sendAt === null || p.intent.kind !== 'cancel_order') continue;
      if (p.venueId !== account.venueId || p.account.owner.toLowerCase() !== account.owner || p.account.subAccount !== account.subAccount)
        continue;
      const o = row.lastOutcome;
      let state: GoodTillDate['state'] = Number(sendAt) > now ? 'scheduled' : 'due';
      let refusal: VenueRefusal | null = null;
      if (o?.definite && o.accepted) {
        // A venue answers a repeat cancel with the cancelled order: when the person's own cancel was accepted first, the
        // order was not open at the expiry, and ours cancelled nothing.
        const own = await this.deps.store.find(principal.userId, `cancel:${p.intent.clientOrderKey}`);
        const ownFirst = own?.lastOutcome?.definite && own.lastOutcome.accepted && own.lastOutcome.asOf.getTime() <= o.asOf.getTime();
        state = ownFirst ? 'not_open' : 'expired';
      } else if (o?.definite && !o.accepted) {
        refusal = o.refusal;
        state = o.refusal.code === 'order_final' || o.refusal.code === 'unknown_order' ? 'not_open' : 'failed';
      }
      out.push({
        actionKey: row.businessKey,
        clientOrderKey: p.intent.clientOrderKey,
        venueClientOrderId: p.venueClientOrderId,
        symbol: p.intent.symbol,
        expiresAt: new Date(Number(sendAt)).toISOString(),
        state,
        refusal,
        answeredAt: o?.definite ? o.asOf.toISOString() : null,
      });
    }
    return out.sort((x, y) => (x.expiresAt < y.expiresAt ? 1 : x.expiresAt > y.expiresAt ? -1 : 0));
  }

  /** One order sent through this door, read by its key: the venue's record, or `unknown` until the venue answers. */
  async orderByKey(principal: Principal, actionKey: string): Promise<VenueOrderByKey> {
    const key = (actionKey ?? '').trim();
    const row = key ? await this.deps.store.find(principal.userId, key) : null;
    if (!row || row.prepared.intent.kind !== 'place_order') {
      throw new UserVenueDoorError(`no order under ${JSON.stringify(key)}`, 'trade.venue_action_unknown', 404);
    }
    return this.orderState(principal.userId, row);
  }

  /**
   * One person's orders on one venue account, oldest first, a page at a time (J-developer-05 #6). Each order once,
   * by its key; the next cursor is null on the last page. The largest page is the owner's value: blank refuses.
   */
  async orders(principal: Principal, owner: string, cursor: string | undefined, limit: string | undefined): Promise<VenueOrderPage> {
    const max = this.deps.ordersPageMax ?? null;
    if (max === null) {
      throw new UserVenueDoorError(
        'the largest page of orders is not set (owner value blank), so no list of orders is served',
        'trade.venue_orders_page_max_unset',
        503,
      );
    }
    let size = max;
    if (limit !== undefined && limit !== '') {
      if (!/^\d+$/.test(limit) || Number(limit) < 1 || Number(limit) > max) {
        throw new UserVenueDoorError(`limit must be a whole number 1 to ${max}`, 'trade.venue_orders_limit_invalid', 400);
      }
      size = Number(limit);
    }
    const after = decodeCursor(cursor);
    const account = await this.account(owner);
    const rows = await this.deps.store.listSignedOrders(principal.userId, account, after, size + 1);
    const page = rows.slice(0, size);
    const orders: VenueOrderByKey[] = [];
    for (const row of page) orders.push(await this.orderState(principal.userId, row));
    return { orders, nextCursor: rows.length > size ? encodeCursor(page[page.length - 1]!) : null };
  }

  private async orderState(userId: string, row: StoredVenueAction): Promise<VenueOrderByKey> {
    const p = row.prepared;
    const base = { actionKey: row.businessKey, venueClientOrderId: p.venueClientOrderId, origin: orderOriginOf(row.businessKey) };
    const recorded = row.lastOutcome;
    if (!row.signature) return { ...base, state: 'not_sent', order: null, asOf: null };
    if (recorded?.definite && !recorded.accepted)
      return { ...base, state: 'refused', refusal: recorded.refusal, order: null, asOf: recorded.asOf };
    const accepted = recorded?.definite && recorded.accepted ? recorded : null;
    if (!p.venueClientOrderId) {
      return accepted
        ? { ...base, state: 'accepted', order: accepted.order, asOf: accepted.asOf }
        : { ...base, state: 'unknown', reason: 'not_on_venue_yet', order: null, asOf: null };
    }
    let read: Awaited<ReturnType<UserVenue['orderByClientId']>>;
    try {
      read = await (await this.venue()).orderByClientId(p.account, p.venueClientOrderId);
    } catch (err) {
      if (!(err instanceof VenueRefusalError && err.refusal.code === 'venue_down')) throw err;
      return accepted
        ? { ...base, state: 'accepted', order: accepted.order, asOf: accepted.asOf }
        : { ...base, state: 'unknown', reason: 'venue_down', order: null, asOf: null };
    }
    if (read.value) {
      // The venue has the order: that settles an answer that was not definite, and it is recorded as the venue's.
      if (!accepted) {
        await this.deps.store.recordOutcome(
          userId,
          row.businessKey,
          { definite: true, accepted: true, venueRef: read.value.venueOrderId, order: read.value, asOf: read.asOf },
          this.deps.now(),
        );
      }
      return { ...base, state: 'accepted', order: read.value, asOf: read.asOf };
    }
    if (accepted) return { ...base, state: 'accepted', order: accepted.order, asOf: accepted.asOf };
    return { ...base, state: 'unknown', reason: 'not_on_venue_yet', order: null, asOf: read.asOf };
  }
}
