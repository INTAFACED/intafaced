import { createHash } from 'node:crypto';
import type { Amount } from '@intafaced/ledger-client/money';
import type { VenueDescriptor } from './adapter.js';
import type { VenueOrderStatus, VenueOrderType } from './account.js';

/**
 * THE USER-SIGNED VENUE — orders the customer signs, on an account the customer owns.
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * WHY THIS IS NOT `TradeAdapter`
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * `TradeAdapter` (adapter.ts) is us acting as a broker: we hold a trade-only API
 * key and route OUR flow. At launch INTAFACED holds no customer money (OWNER
 * 226): the customer's funds sit in the customer's own account on the venue,
 * and every order, cancel, withdrawal and approval is signed by the customer's
 * wallet (or by an agent key the customer approved). We never hold a key that
 * can move the customer's funds, so the shape has to be different:
 *
 *   · **Prepare, sign, submit.** `prepare()` returns the exact payload the
 *     wallet will sign. Nothing is sent. The wallet signs it — or refuses —
 *     outside this interface, and `submit()` sends the signed bytes. Every
 *     check that must happen "before the wallet is asked" (step-up, the agent
 *     cap, a blank builder fee) runs on the `PreparedVenueAction`, between the
 *     two calls, and can refuse with nothing signed and nothing sent.
 *   · **The venue is the record.** Balances, locks, fills, fees, positions and
 *     withdrawals are read from the venue, each with the venue's as-of time.
 *     The ledger records only what is ours (the builder fee earned), against
 *     the venue's record of the fill (AGENTS.md floor 1; OWNER 237).
 *   · **An unknown answer stays unknown.** A submit that times out may have
 *     landed. It returns `{ definite: false }`, and the caller reads the order
 *     back by its client id — it never re-signs or re-sends a new intent.
 *
 * Our own order book becomes one more implementation of this interface
 * (OWNER 237: "every venue behind an adapter"); the TEST venue simulator and
 * the Hyperliquid testnet adapter are the first two.
 *
 * Types and pure functions only. No transport, no venue names, no keys.
 */

// ════════════════════════════════════════════════════════════════════════════
// WHO THE ACCOUNT IS, AND WHO SIGNS
// ════════════════════════════════════════════════════════════════════════════

/** The customer's own account on a venue. Identified by the wallet that owns it. */
export interface UserVenueAccount {
  readonly venueId: string;
  /** The owner wallet's address, lowercase. The venue keys the account by it. */
  readonly owner: string;
  /**
   * A venue sub-account under the owner, or `null` for the main account.
   * An agent gets its own sub-account so its exposure is separable (R5 §3.2).
   */
  readonly subAccount: string | null;
}

/**
 * Who signs an action.
 *
 * `owner` is the customer's wallet. `agent` is a key the owner approved on the
 * venue (`approve_agent`) to trade for it. An agent can never withdraw, approve
 * a builder fee, or approve or revoke an agent: those need the owner, and
 * `assertSignerMaySign` refuses them before the payload reaches any signer.
 */
export type VenueSignerRole = 'owner' | 'agent';

export interface VenueSigner {
  readonly role: VenueSignerRole;
  /** Lowercase address of the signing key. For an agent, the agent key's own address. */
  readonly address: string;
}

// ════════════════════════════════════════════════════════════════════════════
// INTENTS — what the customer asked for, before anything is signed
// ════════════════════════════════════════════════════════════════════════════

export type VenueTimeInForce = 'GTC' | 'IOC' | 'ALO';

export interface PlaceUserOrderIntent {
  readonly kind: 'place_order';
  readonly symbol: string;
  readonly side: 'buy' | 'sell';
  readonly type: VenueOrderType;
  /** Base units, always positive. */
  readonly amount: Amount;
  /** Required on a limit. On a market order, the worst price accepted (the slippage limit). */
  readonly price: Amount;
  /** `ALO` is post-only. A market order is sent as `IOC` at its worst price. */
  readonly timeInForce: VenueTimeInForce;
  readonly reduceOnly: boolean;
  /**
   * The business key of this intent (AGENTS.md floor 3), e.g.
   * `order:<userId>:<deskSession>:<n>`. Never a random id: a retry of the same
   * intent must carry the same key, so the venue sees the same client order id
   * and places at most one order. `venueClientOrderId()` maps it to the venue's
   * own id format.
   */
  readonly clientOrderKey: string;
  /**
   * Our builder fee on this order, from the owner's published value, or
   * `null` for none. The app refuses `builder_fee_not_published` itself when
   * the owner value is blank (floor 8); `prepare` refuses
   * `builder_fee_not_approved` when the account approved less.
   */
  readonly builderFee: {
    readonly builder: string;
    /** Basis points of notional as a scaled decimal (`parseAmount('0.5')` is half a bp), the same scale as `maxFeeBps`, so the two compare directly. */
    readonly feeBps: Amount;
  } | null;
}

/**
 * Set a perpetual's leverage and margin mode for this account. A separate
 * signed action, because a venue sets them per account and market, not per
 * order (Hyperliquid: `updateLeverage`; its order action has no leverage).
 * A perp order uses the account's current setting; `prepare` refuses it
 * `leverage_not_set` when there is none, so the Review screen never shows a
 * margin the venue will not lock. An agent may sign it.
 */
export interface UpdateLeverageIntent {
  readonly kind: 'update_leverage';
  readonly symbol: string;
  /**
   * Basis points of 1x: `100_000` is 10x. A venue that takes only whole
   * leverage (Hyperliquid) refuses a value that is not a multiple of `10_000`
   * as `not_offered` at prepare.
   */
  readonly leverageBps: number;
  readonly marginMode: VenueMarginMode;
}

/** An account's leverage setting on one perpetual market, as the venue records it. */
export interface UserVenueLeverage {
  readonly symbol: string;
  readonly leverageBps: number;
  readonly marginMode: VenueMarginMode;
}

export interface AmendUserOrderIntent {
  readonly kind: 'amend_order';
  readonly symbol: string;
  readonly clientOrderKey: string;
  readonly amount: Amount;
  readonly price: Amount;
}

export interface CancelUserOrderIntent {
  readonly kind: 'cancel_order';
  readonly symbol: string;
  readonly clientOrderKey: string;
}

export interface WithdrawIntent {
  readonly kind: 'withdraw';
  readonly asset: string;
  readonly amount: Amount;
  /** Lowercase destination address. The customer's own wallet. */
  readonly destination: string;
  /** Business key of this withdrawal: what the caller stores the prepared, signed action under (see `prepare`). */
  readonly withdrawalKey: string;
}

export interface ApproveBuilderFeeIntent {
  readonly kind: 'approve_builder_fee';
  /** Our builder address on this venue. */
  readonly builder: string;
  /**
   * The most the customer lets us charge, in basis points of notional, as a
   * scaled decimal (`parseAmount('0.5')` is half a basis point). Every `...Bps:
   * Amount` in this file has this scale, so fractional fees (Hyperliquid sets
   * builder fees in tenths of a basis point) compare exactly.
   */
  readonly maxFeeBps: Amount;
}

/**
 * Approve an agent key. Never re-approve an address that was revoked: a venue
 * that prunes old nonces per signer (Hyperliquid) could then accept a replay of
 * that key's old signed actions. A new agent gets a new key.
 */
export interface ApproveAgentIntent {
  readonly kind: 'approve_agent';
  readonly agentAddress: string;
  /** For humans and the venue's own list. Never parsed. */
  readonly agentName: string;
  /** When the approval lapses on the venue, or `null` for the venue's default. */
  readonly validUntil: Date | null;
}

export interface RevokeAgentIntent {
  readonly kind: 'revoke_agent';
  readonly agentAddress: string;
}

export type VenueIntent =
  | PlaceUserOrderIntent
  | UpdateLeverageIntent
  | AmendUserOrderIntent
  | CancelUserOrderIntent
  | WithdrawIntent
  | ApproveBuilderFeeIntent
  | ApproveAgentIntent
  | RevokeAgentIntent;

export type VenueIntentKind = VenueIntent['kind'];

/** Actions only the owner wallet may sign. */
export const OWNER_ONLY_INTENTS: ReadonlySet<VenueIntentKind> = new Set<VenueIntentKind>([
  'withdraw',
  'approve_builder_fee',
  'approve_agent',
  'revoke_agent',
]);

export type VenueMarginMode = 'cross' | 'isolated';

// ════════════════════════════════════════════════════════════════════════════
// PREPARED → SIGNED → SUBMITTED
// ════════════════════════════════════════════════════════════════════════════

/**
 * What the wallet is asked to sign. Produced by `prepare()`; nothing is sent.
 *
 * Carries the intent it was built from, so a check between prepare and sign
 * (the agent cap, step-up, the builder fee) reads the same figures the wallet
 * will sign and cannot be shown one order while signing another.
 */
export interface PreparedVenueAction {
  readonly venueId: string;
  readonly account: UserVenueAccount;
  readonly signer: VenueSigner;
  readonly intent: VenueIntent;
  /**
   * The venue's anti-replay value for this action (Hyperliquid: a millisecond
   * nonce). Fixed at prepare, so a re-submit of the same signed bytes is the
   * same action to the venue.
   */
  readonly nonce: string;
  /** The venue's own client order id for an order intent; `null` otherwise. */
  readonly venueClientOrderId: string | null;
  /** The payload to sign: EIP-712 typed data as the venue defines it. Opaque here. */
  readonly typedData: unknown;
  /** Hex digest of `typedData`. What the wallet must sign, and what `submit` checks. */
  readonly digest: string;
  /** Builder fee attached to an order, as the venue will charge it; `null` when none. */
  readonly builderFee: { readonly builder: string; /** Scaled decimal bps, as `maxFeeBps`. */ readonly feeBps: Amount } | null;
  readonly preparedAt: Date;
}

export interface VenueSignature {
  /** The digest that was signed. Must equal the prepared action's. */
  readonly digest: string;
  /** Hex signature bytes. */
  readonly signature: string;
  /** Lowercase address recovered or asserted by the wallet. Must equal the prepared signer's. */
  readonly signedBy: string;
}

/**
 * The answer to a submit.
 *
 * `definite: true` — the venue answered and the answer is the record.
 * `definite: false` — the request may or may not have landed (a timeout, a
 * dropped connection, a 5xx after send, or a re-send the venue refuses as a
 * used nonce). The caller MUST read back by client id (`orderByClientId`) or
 * by nonce (`withdrawal`); it never prepares a fresh action for the same
 * intent, because that is how a second order or withdrawal is made. A venue's
 * "nonce already used" answer is never mapped to a definite refusal.
 */
export type VenueSubmitOutcome =
  | {
      readonly definite: true;
      readonly accepted: true;
      readonly venueRef: string | null;
      readonly order: UserVenueOrder | null;
      readonly asOf: Date;
    }
  | {
      readonly definite: true;
      readonly accepted: false;
      readonly refusal: VenueRefusal;
      readonly asOf: Date;
    }
  | {
      readonly definite: false;
      /**
       * What we know: the bytes were sent and no definite answer came back
       * (`timeout`, `connection_lost`, `venue_error_after_send`), or the venue
       * says it has already seen this nonce (`already_submitted`) — so the
       * first send may have landed, and only a read-back can say.
       */
      readonly reason: 'timeout' | 'connection_lost' | 'venue_error_after_send' | 'already_submitted';
    };

/** True when the caller must read back before anything else: the answer is not definite. */
export function needsReadBack(outcome: VenueSubmitOutcome): outcome is Extract<VenueSubmitOutcome, { definite: false }> {
  return !outcome.definite;
}

// ════════════════════════════════════════════════════════════════════════════
// REFUSALS — typed, named, never a plausible-looking rejected order
// ════════════════════════════════════════════════════════════════════════════

export type VenueRefusalCode =
  /** The venue is down or unreachable. Its controls refuse with this; nothing is sent. */
  | 'venue_down'
  /** The order type, time in force or margin mode is not offered on this venue or market. */
  | 'not_offered'
  /** Our builder fee is blank (no owner value): orders with a builder fee refuse (floor 8). */
  | 'builder_fee_not_published'
  /** The account has not approved our builder fee, or approved less than the order carries. */
  | 'builder_fee_not_approved'
  /** An agent key tried an owner-only action (withdraw, approvals). */
  | 'agent_not_permitted'
  /** The signer is not the account's owner or an approved agent. */
  | 'signer_not_authorised'
  /** The signature is over a different payload, or from a different key, than the one prepared. */
  | 'signature_mismatch'
  /** The venue's free balance does not cover the lock or the withdrawal. */
  | 'insufficient_balance'
  /** The market is not listed on this venue. */
  | 'unknown_market'
  /** A perpetual order on an account with no leverage set for that market (`update_leverage` first). */
  | 'leverage_not_set'
  /** No order with that client id exists on the venue. */
  | 'unknown_order'
  /** The order is already final (filled, cancelled, rejected). */
  | 'order_final'
  /** A TEST venue (simulator, testnet) asked for outside APP_ENV dev or test. */
  | 'test_venue_outside_test'
  /** The client order key is not a business key (blank, or a random id). */
  | 'invalid_client_order_key'
  /**
   * The venue refused the action's nonce for a reason that guarantees it was
   * not applied (below the venue's kept set, or outside its time window).
   * A "nonce already used" answer is never this: that is `already_submitted`.
   */
  | 'nonce_rejected'
  /** The venue refused for its own stated reason; the text is in `detail`. */
  | 'venue_rejected'
  /** An agent order would commit more than the room left under the person's cap (agent-cap.ts). Nothing signed. */
  | 'agent_cap_exceeded'
  /** The agent's cap is revoked or expired: only cancels are signed. */
  | 'agent_cap_inactive'
  /** The room under the cap can't be measured (a holding with no known mark, a market in another quote). Nothing signed. */
  | 'agent_cap_unmeasured'
  /** Not the cap's agent key, or not the agent's own sub-account. */
  | 'agent_outside_capped_account';

export interface VenueRefusal {
  readonly venueId: string;
  readonly code: VenueRefusalCode;
  /** The venue's own words, or ours where the refusal is ours. Never a raw code alone. */
  readonly detail: string;
}

export class VenueRefusalError extends Error {
  constructor(readonly refusal: VenueRefusal) {
    super(`${refusal.venueId}: ${refusal.code}: ${refusal.detail}`);
    this.name = 'VenueRefusalError';
  }
}

// ════════════════════════════════════════════════════════════════════════════
// READS — the venue's record, each with its as-of time
// ════════════════════════════════════════════════════════════════════════════

/** A figure the venue may not publish. `known: false` is shown as "not known", never as 0. */
export type MaybeKnown<T> = { readonly known: true; readonly value: T } | { readonly known: false };

export interface UserVenueBalance {
  readonly asset: string;
  /** Free to trade or withdraw. */
  readonly free: Amount;
  /** Locked by resting orders or used as margin. */
  readonly locked: Amount;
  /** As the venue reports it, not derived (see account.ts `VenueBalance.total`). */
  readonly total: Amount;
}

export interface UserVenueFill {
  /** The venue's own stable trade id. Our ledger keys the builder fee earned on it (once per fill). */
  readonly fillId: string;
  readonly venueClientOrderId: string | null;
  readonly symbol: string;
  readonly side: 'buy' | 'sell';
  readonly price: Amount;
  readonly amount: Amount;
  readonly role: 'maker' | 'taker';
  /** The venue's own fee for this fill. */
  readonly venueFee: Amount;
  /** Our builder fee on this fill, as the venue charged it. Zero when none was attached. */
  readonly builderFee: Amount;
  readonly feeAsset: string;
  /** Realised result the venue reports for a closing fill; `null` on an opening fill or spot. */
  readonly realisedPnl: Amount | null;
  readonly filledAt: Date;
}

export interface UserVenueOrder {
  readonly venueOrderId: string | null;
  /**
   * `null` for an order the customer placed on the venue directly, without a
   * client id: it still locks funds, so it is listed, never dropped or given
   * an invented id.
   */
  readonly venueClientOrderId: string | null;
  readonly symbol: string;
  readonly side: 'buy' | 'sell';
  readonly type: VenueOrderType;
  readonly timeInForce: VenueTimeInForce;
  readonly price: Amount;
  readonly amount: Amount;
  readonly filled: Amount;
  readonly remaining: Amount;
  readonly averagePrice: Amount | null;
  readonly status: VenueOrderStatus;
  /** What the venue locks for this order now. Zero once final. */
  readonly locked: Amount;
  readonly lockedAsset: string;
  readonly reduceOnly: boolean;
}

export interface UserVenuePosition {
  readonly symbol: string;
  readonly side: 'long' | 'short';
  readonly size: Amount;
  readonly entryPrice: Amount;
  readonly markPrice: Amount;
  readonly unrealisedPnl: Amount;
  readonly marginMode: VenueMarginMode;
  readonly margin: Amount;
  readonly leverageBps: number;
  /** `known: false` where the venue publishes none — never read as "far away". */
  readonly liquidationPrice: MaybeKnown<Amount>;
}

export type UserVenueWithdrawalStatus = 'pending' | 'done' | 'failed';

export interface UserVenueWithdrawal {
  /** The nonce of the signed withdrawal. Our `withdrawalKey` lives in our own records, not the venue's. */
  readonly nonce: string;
  readonly asset: string;
  readonly amount: Amount;
  /**
   * Lowercase destination address, or `null` when the venue does not report
   * it for this withdrawal (its record names none, and the reader did not
   * send it). Never a made-up value (AGENTS.md floor 8).
   */
  readonly destination: string | null;
  readonly status: UserVenueWithdrawalStatus;
  /** The venue's withdrawal fee, or `known: false` when it does not publish one. */
  readonly fee: MaybeKnown<Amount>;
}

export interface UserVenueAgent {
  readonly address: string;
  readonly name: string;
  /** `null` when the venue sets no expiry. */
  readonly validUntil: Date | null;
}

/** Every read is a snapshot of the venue's record at the venue's own time. */
export interface AsOf<T> {
  readonly venueId: string;
  readonly value: T;
  /** The venue's own timestamp for the record, or when we read it if the venue gives none. */
  readonly asOf: Date;
}

export interface UserVenueMarket {
  readonly symbol: string;
  readonly kind: 'spot' | 'perpetual';
  readonly baseAsset: string;
  readonly quoteAsset: string;
  /** What this venue offers on this market. Anything else refuses `not_offered`. */
  readonly orderTypes: readonly VenueOrderType[];
  readonly timeInForce: readonly VenueTimeInForce[];
  readonly marginModes: readonly VenueMarginMode[];
  readonly maxLeverageBps: number | null;
  readonly tickSize: Amount;
  readonly lotSize: Amount;
  /** The venue's published fee for this account, or `known: false`. */
  readonly makerFeeBps: MaybeKnown<Amount>;
  readonly takerFeeBps: MaybeKnown<Amount>;
}

/** One figure of a preview: an amount in a named asset. */
export interface VenueAssetAmount {
  readonly asset: string;
  readonly amount: Amount;
}

/**
 * What an order would do, as the venue would compute it now, without sending
 * anything (the Review screen's figures). Every line is the venue's, never
 * ours: a figure the venue does not publish is `known: false`, never zero.
 */
export interface VenueOrderPreview {
  readonly symbol: string;
  readonly kind: 'spot' | 'perpetual';
  /** What the venue locks for this order when it is accepted, and in which asset. */
  readonly lock: VenueAssetAmount;
  /**
   * The role the order's first fill takes: `taker` when it meets resting
   * liquidity now (or is IOC/market), `maker` when it would rest.
   */
  readonly role: 'maker' | 'taker';
  /**
   * The venue's own fee if the order fills in full: the part that meets the
   * book now at the taker rate and its fill prices, the rest (a resting order)
   * at the maker rate and the limit price. An IOC's unfilled rest pays nothing.
   */
  readonly venueFee: MaybeKnown<VenueAssetAmount>;
  /** Our builder fee on the same basis; known zero when the order carries none. */
  readonly builderFee: MaybeKnown<VenueAssetAmount>;
  /** Perpetuals only; `null` on spot. */
  readonly perpetual: {
    readonly leverageBps: number;
    readonly marginMode: VenueMarginMode;
    /** Margin the order posts at its limit price (zero for reduce-only). */
    readonly initialMargin: MaybeKnown<Amount>;
    /** Of the position after the order fills in full; `known: false` where the venue publishes none. */
    readonly liquidationPrice: MaybeKnown<Amount>;
  } | null;
}

// ════════════════════════════════════════════════════════════════════════════
// THE INTERFACE
// ════════════════════════════════════════════════════════════════════════════

export interface UserVenueDescriptor extends VenueDescriptor {
  /**
   * Which proof level its results count as (R5 §3.2). Anything but `live` is
   * a TEST venue (`isTestVenue`): every figure from it is labelled TEST, and
   * `refuseTestVenueOutsideTest` refuses it outside APP_ENV dev or test
   * (AGENTS.md floor 8). One field, so the two can never disagree.
   */
  readonly proofLevel: 'simulator' | 'partner-sandbox' | 'live';
}

/** True for the TEST simulator and any testnet or partner sandbox. */
export function isTestVenue(venue: UserVenueDescriptor): boolean {
  return venue.proofLevel !== 'live';
}

export interface UserVenue {
  readonly venue: UserVenueDescriptor;

  // ── market reads, no account ───────────────────────────────────────────
  /** Markets this venue lists for this account and region. Throws `VenueRefusalError('venue_down')` when down. */
  markets(account: UserVenueAccount | null): Promise<AsOf<readonly UserVenueMarket[]>>;

  /**
   * What `intent` would lock and cost on `account` now, from the same rules
   * `submit` applies, with nothing prepared, signed or sent. Refuses what
   * `prepare` refuses on its face (`unknown_market`, `not_offered`,
   * `leverage_not_set`, ...). A preview is not a quote: the book can move
   * before the order lands.
   */
  preview(account: UserVenueAccount, intent: PlaceUserOrderIntent): Promise<AsOf<VenueOrderPreview>>;

  // ── signed actions ─────────────────────────────────────────────────────
  /**
   * Build the payload `signer` will sign for `intent`. Sends nothing.
   *
   * Refuses (throws `VenueRefusalError`) what would fail on its face, so the
   * wallet is never asked to sign an action that cannot succeed:
   * `not_offered`, `unknown_market`, `leverage_not_set`, `agent_not_permitted`,
   * `signer_not_authorised` (an owner address that is not the account's, or an
   * agent the venue's `agents()` record does not hold), `builder_fee_not_approved`
   * (the venue's `builderFeeApproval()` is below the order's fee), and
   * `not_offered` for a withdrawal from a sub-account (a venue sub-account has
   * no key of its own; moving its funds back is a later intent). Balance
   * checks are the venue's, at submit.
   *
   * ONE PREPARED ACTION PER BUSINESS KEY. The nonce is fixed here, so two
   * prepares of one intent are two digests and two wallet prompts. The caller
   * stores the prepared action and its signature under the intent's business
   * key (`clientOrderKey`, `withdrawalKey`, or one the caller derives for an
   * approval) BEFORE `submit`, and never prepares a stored key again: a double
   * press re-uses the stored action, and asks for one signature. After a
   * `definite: false` answer it reads back (by client id or nonce) and may
   * re-send the same stored bytes. This, not the venue, is the guarantee; the
   * same order intent also always maps to the same `venueClientOrderId`, so a
   * venue that refuses a duplicate client id is a second line of defence.
   */
  prepare(account: UserVenueAccount, signer: VenueSigner, intent: VenueIntent): Promise<PreparedVenueAction>;

  /**
   * Send a signed action. Refuses `signature_mismatch` with nothing sent when
   * the signature's digest or signer does not match the prepared action
   * (`assertSignatureMatches`), and must verify the signature bytes
   * themselves against `prepared.signer.address` — the wallet's `signedBy` is
   * a claim, not proof.
   * Re-submitting the same signed action is never a second action: it returns
   * the venue's first answer, or `definite: false, reason: 'already_submitted'`
   * when the venue only says the nonce is used.
   */
  submit(prepared: PreparedVenueAction, signature: VenueSignature): Promise<VenueSubmitOutcome>;

  // ── account reads, the venue's record ──────────────────────────────────
  balances(account: UserVenueAccount): Promise<AsOf<readonly UserVenueBalance[]>>;
  openOrders(account: UserVenueAccount): Promise<AsOf<readonly UserVenueOrder[]>>;
  /** `null` is a confirmed miss: the venue has no order with this client id. */
  orderByClientId(account: UserVenueAccount, venueClientOrderId: string): Promise<AsOf<UserVenueOrder | null>>;
  fills(account: UserVenueAccount, since: Date): Promise<AsOf<readonly UserVenueFill[]>>;
  positions(account: UserVenueAccount): Promise<AsOf<readonly UserVenuePosition[]>>;
  /** By the signed action's nonce, the only id the venue knows it by. `null` is a confirmed miss. */
  withdrawal(account: UserVenueAccount, nonce: string): Promise<AsOf<UserVenueWithdrawal | null>>;
  /** The most the account has approved for `builder`, in bps; zero when never approved. */
  builderFeeApproval(account: UserVenueAccount, builder: string): Promise<AsOf<Amount>>;
  agents(account: UserVenueAccount): Promise<AsOf<readonly UserVenueAgent[]>>;
  /**
   * The account's leverage setting on `symbol`, or `null` when none is set
   * (a venue with a default per market reports that default). What the Review
   * screen's margin is computed from, and what an `update_leverage` answer
   * that is not definite is read back by.
   */
  leverage(account: UserVenueAccount, symbol: string): Promise<AsOf<UserVenueLeverage | null>>;
}

// ════════════════════════════════════════════════════════════════════════════
// PURE GUARDS every implementation and every caller share
// ════════════════════════════════════════════════════════════════════════════

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const BUSINESS_KEY_RE = /^[a-z][a-z0-9-]*:.+$/;

/**
 * Map a business key to the venue's 128-bit client order id (`0x` + 32 hex,
 * Hyperliquid's `cloid` format), deterministically: the same key always gives
 * the same id, so a retried intent can only ever name the same venue order.
 *
 * Refuses a blank key, a bare UUID and a key without a `<kind>:` prefix. That
 * catches the obvious mistakes only: `order:${randomUUID()}` passes, because a
 * real key may hold a user's UUID. What makes a key a business key (AGENTS.md
 * floor 3) is that the caller derives it from the intent, and the caller's own
 * retry test proves it is stable.
 */
export function venueClientOrderId(venueId: string, clientOrderKey: string): string {
  const key = clientOrderKey.trim();
  if (UUID_RE.test(key) || !BUSINESS_KEY_RE.test(key)) {
    throw new VenueRefusalError({
      venueId,
      code: 'invalid_client_order_key',
      detail: `client order key "${clientOrderKey}" is not a business key (expected "<kind>:<owner>:<intent>", never a random id)`,
    });
  }
  const hex = createHash('sha256').update(`${venueId}\u0000${key}`).digest('hex').slice(0, 32);
  return `0x${hex}`;
}

/**
 * Refuse, before anything is signed: an `owner` signer whose address is not
 * the account's owner, and an owner-only intent from an agent key. Whether an
 * agent key is approved on the account is the venue's record (`agents()`),
 * which `prepare` reads; this guard needs no venue.
 */
export function assertSignerMaySign(account: UserVenueAccount, signer: VenueSigner, intent: VenueIntent): void {
  const venueId = account.venueId;
  if (signer.role === 'owner' && signer.address.toLowerCase() !== account.owner.toLowerCase()) {
    throw new VenueRefusalError({
      venueId,
      code: 'signer_not_authorised',
      detail: `${signer.address.toLowerCase()} is not the owner of this account (${account.owner.toLowerCase()})`,
    });
  }
  if (signer.role === 'agent' && OWNER_ONLY_INTENTS.has(intent.kind)) {
    throw new VenueRefusalError({
      venueId,
      code: 'agent_not_permitted',
      detail: `an agent key cannot sign ${intent.kind}; only the account owner's wallet can`,
    });
  }
}

/**
 * Refuse a signature that does not belong to the prepared action. Nothing is sent.
 *
 * A cheap pre-check on what the wallet claims, NOT verification: `signedBy` is
 * the wallet's own report. Every `submit` must also verify the signature
 * bytes against the prepared signer (a real venue does so itself; the TEST
 * simulator must recover the signer the same way).
 */
export function assertSignatureMatches(prepared: PreparedVenueAction, signature: VenueSignature): void {
  if (signature.digest.toLowerCase() !== prepared.digest.toLowerCase()) {
    throw new VenueRefusalError({
      venueId: prepared.venueId,
      code: 'signature_mismatch',
      detail: 'the signature is for a different payload than the one prepared',
    });
  }
  if (signature.signedBy.toLowerCase() !== prepared.signer.address.toLowerCase()) {
    throw new VenueRefusalError({
      venueId: prepared.venueId,
      code: 'signature_mismatch',
      detail: `signed by ${signature.signedBy.toLowerCase()}, prepared for ${prepared.signer.address.toLowerCase()}`,
    });
  }
}

/**
 * A TEST venue (simulator, testnet, partner sandbox) is refused unless
 * `appEnv` is exactly `dev` or `test` — the same rule as `isExplicitDevOrTest`
 * (packages/config/src/app-env.ts), restated here so this package keeps no
 * config dependency. Pass the RAW `process.env.APP_ENV`, never a parsed config
 * value that defaults to `dev`: unset, blank and anything else count as live.
 */
export function refuseTestVenueOutsideTest(venue: UserVenueDescriptor, appEnv: string | null | undefined): void {
  if (isTestVenue(venue) && appEnv !== 'dev' && appEnv !== 'test') {
    throw new VenueRefusalError({
      venueId: venue.id,
      code: 'test_venue_outside_test',
      detail: `${venue.displayName} is a TEST venue and is refused outside APP_ENV dev or test (APP_ENV: ${appEnv ?? 'unset'})`,
    });
  }
}
