import { hashTypedData, recoverTypedDataAddress, type Hex, type TypedDataDefinition } from 'viem';
import { formatAmount, parseAmount, type Amount } from '@intafaced/ledger-client/money';
import type { Principal } from '@intafaced/auth';
import type { StepUpCheck } from '@intafaced/contracts';
import {
  VenueRefusalError,
  assertSignatureMatches,
  encodeVenueWire,
  isTestVenue,
  refuseTestVenueOutsideTest,
  type PlaceUserOrderIntent,
  type PreparedVenueAction,
  type UserVenue,
  type UserVenueAccount,
  type VenueIntent,
  type VenueSignature,
  type VenueSigner,
  type VenueSubmitOutcome,
} from '@intafaced/venue-contracts';
import type { PreparedActionStore, StoredVenueAction } from './prepared-action-store.js';

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
 *   · Our builder fee comes from the owner value, never from the request. Blank, every order refuses
 *     `builder_fee_not_published` before the venue is asked (AGENTS.md floor 8).
 *   · The ledger posts nothing and no event is sent: the venue is the record of balances, locks, fills and withdrawals.
 */

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
  | 'trade.venue_action_unknown';

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

export interface UserVenueDoorDeps {
  /** Reach the venue. Called until it succeeds; its descriptor is checked against APP_ENV each time it connects. */
  readonly connect: () => Promise<UserVenue & { readonly chainId?: number }>;
  /** The RAW `process.env.APP_ENV`. */
  readonly appEnv: string | undefined;
  readonly store: PreparedActionStore;
  readonly stepUp: StepUpCheck;
  readonly builder: BuilderFeeValue | null;
  readonly now: () => Date;
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
  private venuePromise: Promise<UserVenue & { readonly chainId?: number }> | null = null;

  constructor(private readonly deps: UserVenueDoorDeps) {}

  /** The connected venue, checked against APP_ENV. A failed connect is retried on the next call. */
  async venue(): Promise<UserVenue & { readonly chainId?: number }> {
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
    let venue: UserVenue & { readonly chainId?: number };
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
      builder: this.deps.builder ? { address: this.deps.builder.address, feeBps: formatAmount(this.deps.builder.feeBps) } : null,
    };
  }

  async account(owner: string, subAccount?: string | null): Promise<UserVenueAccount> {
    const o = (owner ?? '').trim().toLowerCase();
    if (!ADDRESS_RE.test(o)) invalid('owner must be the wallet address of the venue account (0x and 40 hex)');
    const venue = await this.venue();
    return { venueId: venue.venue.id, owner: o, subAccount: subAccount ?? null };
  }

  /** An order with our builder fee from the owner value; blank refuses before the venue is asked. */
  private withBuilderFee(venueId: string, intent: PlaceUserOrderIntent): PlaceUserOrderIntent {
    const builder = this.deps.builder;
    if (!builder) {
      throw new VenueRefusalError({
        venueId,
        code: 'builder_fee_not_published',
        detail: 'our builder fee is not published (owner value blank), so no order is prepared',
      });
    }
    return { ...intent, builderFee: { builder: builder.address, feeBps: builder.feeBps } };
  }

  async preview(_principal: Principal, owner: string, intent: VenueIntent) {
    if (intent?.kind !== 'place_order') invalid('preview takes an order intent (kind place_order)');
    const venue = await this.venue();
    const account = await this.account(owner);
    return venue.preview(account, this.withBuilderFee(venue.venue.id, intent));
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

  async prepare(principal: Principal, req: PrepareRequest): Promise<PreparedAnswer> {
    const intent = req.intent;
    if (!intent || typeof intent !== 'object' || typeof intent.kind !== 'string') invalid('intent is required');
    if (
      !req.signer ||
      (req.signer.role !== 'owner' && req.signer.role !== 'agent') ||
      !ADDRESS_RE.test(req.signer.address?.toLowerCase() ?? '')
    ) {
      invalid('signer must be { role: owner|agent, address: 0x... }');
    }
    const key = this.businessKey(intent, req.actionKey);

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
    if (intent.kind === 'place_order') finalIntent = this.withBuilderFee(venue.venue.id, intent);
    if (intent.kind === 'approve_builder_fee') {
      const builder = this.deps.builder;
      if (!builder) {
        throw new VenueRefusalError({
          venueId: venue.venue.id,
          code: 'builder_fee_not_published',
          detail: 'our builder is not published (owner value blank)',
        });
      }
      if (intent.builder.toLowerCase() !== builder.address) invalid(`the builder to approve is ours, ${builder.address}`);
    }

    const existing = await this.deps.store.find(principal.userId, key);
    if (existing) return this.reuse(existing, account, signer, finalIntent);

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
    if (
      !signature ||
      typeof signature.signature !== 'string' ||
      typeof signature.digest !== 'string' ||
      typeof signature.signedBy !== 'string'
    ) {
      invalid('signature must be { digest, signature, signedBy }');
    }
    let signed = row;
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
