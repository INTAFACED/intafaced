import { hashTypedData, recoverTypedDataAddress, type Hex, type TypedDataDefinition } from 'viem';
import { formatAmount, parseAmount, type Amount } from '@intafaced/ledger-client/money';
import { AuthError, isApiKeyPrincipal, type Principal } from '@intafaced/auth';
import type { StepUpCheck } from '@intafaced/contracts';
import {
  OWNER_ONLY_INTENTS,
  VenueRefusalError,
  assertSignatureMatches,
  encodeVenueWire,
  isTestVenue,
  refuseTestVenueOutsideTest,
  type PlaceUserOrderIntent,
  type PreparedVenueAction,
  type UserVenue,
  type UserVenueAccount,
  type UserVenueDepositRoute,
  type VenueIntent,
  type VenueSignature,
  type VenueSigner,
  type VenueSubmitOutcome,
} from '@intafaced/venue-contracts';
import type { PreparedActionStore, StoredVenueAction } from './prepared-action-store.js';
import { VenueRouteRefusal, type ListedVenueMarket, type VenueRouteRefusalCode, type VenueRoutingGate } from './venue-listing.js';
import { BuilderFeeVersionError, builderFeeOf, type BuilderFeeBook } from './builder-fee-versions.js';

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

const MARKET_KINDS_TTL_MS = 60_000;
/** On a symbol the list doesn't hold, the list is read again at most this often, so unlisted symbols can't each cost a venue read. */
const MARKET_MISS_REREAD_MS = 5_000;

export const VENUE_WITHDRAW_STEP_UP_SCOPE = 'trade.step_up.venue.withdraw' as const;

/** Identity's step-up request id is at most 128 characters. */
const STEP_UP_REQUEST_ID_MAX = 128;
const BUSINESS_KEY_RE = /^[a-z][a-z0-9-]*:.+$/;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const ADDRESS_RE = /^0x[0-9a-f]{40}$/;

export type UserVenueDoorCode =
  | 'trade.user_venue_off'
  | 'trade.venue_request_invalid'
  | 'trade.venue_action_key_invalid'
  | 'trade.venue_action_key_reused'
  | 'trade.venue_builder_fee_changed'
  | 'trade.venue_action_unknown'
  | 'trade.venue_action_key_reserved'
  | 'trade.venue_session_key_reused'
  | 'trade.venue_session_pending'
  | 'trade.venue_session_none'
  | 'trade.venue_session_unavailable'
  | 'trade.venue_session_superseded'
  // Convert's venue sell quotes (venue-sell-quotes.ts, J-cex-spot-17 #8).
  | 'trade.venue_sell_quote_unwired'
  | 'trade.venue_sell_quote_market_unknown'
  | 'trade.venue_sell_quote_not_spot'
  | 'trade.venue_sell_quote_key_reused'
  | VenueRouteRefusalCode;

/**
 * The trading session's keys (J-wallet-22 #8, D-venue-09; src/venue/session-key.ts): the owner's `approve_agent` for a
 * session key is stored under `session-key:<accountId>:<venueId>:<sessionId>`, and its `revoke_agent` under
 * `session-key-end:` with the same tail. Only the session routes prepare under these keys, so the rule "a new session
 * approves a new key, never one used before" cannot be walked around through the plain prepare route.
 */
export const SESSION_KEY_PREFIX = 'session-key:';
export const SESSION_KEY_END_PREFIX = 'session-key-end:';
const RESERVED_KEY_PREFIXES = [SESSION_KEY_PREFIX, SESSION_KEY_END_PREFIX] as const;

export interface PrepareOptions {
  /** Set only by the session routes (session-key.ts): lets the action be stored under a reserved session key. */
  readonly sessionKey?: boolean;
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
  /** The builder-fee book of the fee schedule version in force at `at` (null: none, the boot `builder` fee applies). */
  readonly builderFeesAt?: (at: Date) => Promise<BuilderFeeBook | null>;
  readonly now: () => Date;
  /** Our listings, routing states and largest routed orders (J-cex-spot-16). */
  readonly listings: VenueRoutingGate;
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

  /** Each listed symbol's market kind, read once a minute, so an order costs no extra venue read. */
  private marketKinds: { at: number; kinds: Map<string, 'spot' | 'perpetual'> } | null = null;

  private async marketKind(venue: UserVenue, symbol: string): Promise<'spot' | 'perpetual'> {
    const now = this.deps.now().getTime();
    const fresh = this.marketKinds && now - this.marketKinds.at < MARKET_KINDS_TTL_MS ? this.marketKinds : null;
    let kind = fresh?.kinds.get(symbol);
    // A miss re-reads the list, so a market listed since the last read is found within seconds, but not more often than
    // once per MARKET_MISS_REREAD_MS: inside that, an unlisted symbol is refused from the list just read.
    const justRead = fresh !== null && now - fresh.at < MARKET_MISS_REREAD_MS;
    if (!kind && !justRead) {
      const kinds = new Map((await venue.markets(null)).value.map((m) => [m.symbol, m.kind] as const));
      this.marketKinds = { at: now, kinds };
      kind = kinds.get(symbol);
    }
    if (!kind) {
      throw new VenueRefusalError({ venueId: venue.venue.id, code: 'unknown_market', detail: `${symbol} is not listed on this venue` });
    }
    return kind;
  }

  /** Our builder address on the venue: the owner value, or null when it is blank. */
  private builderAddress(): string | null {
    return this.deps.builder?.address ?? null;
  }

  /**
   * An order with our builder fee: the builder-fee version in force now for its venue and market group, else the boot
   * owner value. Blank refuses before the venue is asked. A spot buy carries none and so never needs it published or
   * approved: the venue charges builder fees only on a spot sell and on both sides of a perp ("builder codes do not
   * apply to the buying side of spot trades", Hyperliquid's builder-codes page, read 9 Nov 2026; project-state #1888).
   */
  private async withBuilderFee(venue: UserVenue, intent: PlaceUserOrderIntent): Promise<PlaceUserOrderIntent> {
    const venueId = venue.venue.id;
    const kind = await this.marketKind(venue, intent.symbol);
    if (kind === 'spot' && intent.side === 'buy') return { ...intent, builderFee: null };
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

  /** A new order our listing, routing state, dates or largest order refuse, as this door's typed refusal. */
  private async admitPlace(venueId: string, intent: PlaceUserOrderIntent): Promise<void> {
    try {
      await this.deps.listings.admitPlace(venueId, intent, this.deps.now());
    } catch (err) {
      if (err instanceof VenueRouteRefusal) throw new UserVenueDoorError(err.message, err.code, 422);
      throw err;
    }
  }

  async preview(_principal: Principal, owner: string, intent: VenueIntent) {
    if (intent?.kind !== 'place_order') invalid('preview takes an order intent (kind place_order)');
    assertPlaceIntent(intent);
    const venue = await this.venue();
    // The same order as prepare: the venue's own market list first (a symbol it does not list is its `unknown_market`),
    // then our builder fee, then our listing, routing state, dates and largest order.
    const withFee = await this.withBuilderFee(venue, intent);
    await this.admitPlace(venue.venue.id, withFee);
    const account = await this.account(owner);
    return venue.preview(account, withFee);
  }

  /** The key the action is stored under: the intent's own business key where it has one. */
  private businessKey(intent: VenueIntent, actionKey: string | null | undefined): string {
    let key: string | null | undefined;
    if (intent.kind === 'place_order') key = intent.clientOrderKey;
    else if (intent.kind === 'withdraw') key = intent.withdrawalKey;
    else if (intent.kind === 'cancel_order') key = actionKey ?? `cancel:${intent.clientOrderKey}`;
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
    const intent = req.intent;
    if (!intent || typeof intent !== 'object' || typeof intent.kind !== 'string') invalid('intent is required');
    if (
      !req.signer ||
      (req.signer.role !== 'owner' && req.signer.role !== 'agent') ||
      !ADDRESS_RE.test(req.signer.address?.toLowerCase() ?? '')
    ) {
      invalid('signer must be { role: owner|agent, address: 0x... }');
    }
    assertInteractive(principal, intent.kind);
    if (intent.kind === 'place_order') assertPlaceIntent(intent);
    const key = this.businessKey(intent, req.actionKey);
    if (!opts.sessionKey && RESERVED_KEY_PREFIXES.some((prefix) => key.startsWith(prefix))) {
      throw new UserVenueDoorError(
        `the action key ${JSON.stringify(key)} belongs to the trading session's own routes (/api/v1/venue/session/...)`,
        'trade.venue_action_key_reserved',
        409,
      );
    }
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
    if (existing) return this.reuse(existing, account, signer, finalIntent);
    if (finalIntent.kind === 'place_order') await this.admitPlace(venue.venue.id, finalIntent);

    const prepared = await venue.prepare(account, signer, finalIntent);
    const stored = await this.deps.store.insertOnce(principal.userId, key, prepared, this.deps.now());
    // A concurrent prepare of the same key may have won the insert: the stored action is the one.
    if (stored.prepared.digest !== prepared.digest) return this.reuse(stored, account, signer, finalIntent);
    return { actionKey: key, prepared: stored.prepared, reused: false, signed: false, lastOutcome: null };
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
        `the action key ${row.businessKey} was already used for a different action; a new action needs a new key`,
        'trade.venue_action_key_reused',
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
  async submit(principal: Principal, actionKey: string, signature: VenueSignature): Promise<SubmitAnswer> {
    const key = (actionKey ?? '').trim();
    const row = await this.deps.store.find(principal.userId, key);
    if (!row)
      throw new UserVenueDoorError(`no prepared action under ${JSON.stringify(key)}: prepare it first`, 'trade.venue_action_unknown', 404);
    assertInteractive(principal, row.prepared.intent.kind);
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
    let signed = row;
    // An order never sent yet is checked again: a stop or limit approved since it was prepared applies to it.
    if (!row.signature && row.prepared.intent.kind === 'place_order') await this.admitPlace(row.prepared.venueId, row.prepared.intent);
    if (!row.signature) {
      assertSignatureMatches(row.prepared, signature);
      await assertSignatureRecovers(row.prepared, signature);
      signed = await this.deps.store.signOnce(principal.userId, key, signature, this.deps.now());
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
    const outcome = await this.deps.store.recordOutcome(principal.userId, key, answered, this.deps.now());
    return { actionKey: key, outcome, readBack: readBackOf(outcome) };
  }
}
