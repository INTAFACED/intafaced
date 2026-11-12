import { add, compare, div, formatAmount, mul, parseAmount, sub, ZERO, type Amount } from '@intafaced/ledger-client/money';
import type { Principal } from '@intafaced/auth';
import type { TypedDataDefinition } from 'viem';
import {
  AgentCapError,
  CappedAgentSigner,
  VenueRefusalError,
  assertAgentCapWithinCeiling,
  hasSubAccountReads,
  isTestVenue,
  type AgentCap,
  type AgentCapMarks,
  type PlaceUserOrderIntent,
  type PreparedVenueAction,
  type UserVenue,
  type UserVenueAccount,
  type UserVenueMarket,
  type UserVenueOrder,
  type VenueIntent,
  type VenueRefusal,
  type VenueSignature,
  type VenueSubmitOutcome,
} from '@intafaced/venue-contracts';
import { AgentAccountError, assertPerson, capErrorAs, type AgentAccountValues } from './agent-account.js';
import { AgentVenueRefusal } from './agent-orders.js';
import { agentAddressFor, agentKeyFor } from './agent-key.js';
import {
  allowanceLeft,
  type AllowancePeriod,
  type AllowanceRecord,
  type AllowanceStore,
  type DrawRecord,
} from './own-agent-allowance-store.js';
import type { OwnAgentPolicy } from './own-agent-policy-client.js';
import { AGENT_ORDER_PREFIX, UserVenueDoorError, type UserVenueDoor } from './user-venue-door.js';

/**
 * A PERSON'S OWN AGENT TRADING ONE OF THEIR VENUE SUB-ACCOUNTS, UNDER AN ALLOWANCE (J-agents-08 #3 to #7; AG-spend-03,
 * RC-agents-06).
 *
 * The person gives their own agent (svc-agents' own agent, the one they built) an allowance: the most notional it may
 * commit, in all, on the one sub-account they gave it access to (J-agents-08 #2), until the period ends. The allowance is
 * a limit, never money: INTAFACED holds and moves nothing, the ledger posts nothing, and the venue is the record of what
 * the sub-account holds. Granting it asks the person's wallet to sign the venue's agent permission for the key INTAFACED
 * holds for this allowance (agent-key.ts, derived from the allowance id), on that sub-account only; a signature the
 * wallet rejects is never sent, so nothing is granted. That key can trade the sub-account and nothing else: the venue
 * refuses it a withdrawal or an approval (`assertSignerMaySign`), and the door refuses one before it is prepared.
 *
 * An order, in order: the agent drafts it from the person's words (svc-agents), the person sees a preview (#5): side,
 * market, type, size, price and the venue's own fee, and nothing is sent; on the person's approval (#6) svc-agents'
 * gate is asked again (rules and access), the draw is admitted under the allowance's row lock (two draws that together
 * exceed it admit one), and only then does the agent key sign, through `CappedAgentSigner` (the allowance is its cap: a
 * backstop that also refuses once the allowance is revoked or ended). The order is sent once, under
 * `agent:order:<agentId>:<orderId>` with the order id the page chose at its preview as the business key; the venue's
 * client order id derives from it. A retry reads the venue's record by that client order id first and re-sends only the
 * stored, signed bytes.
 *
 * Revoking (#7) ends admission at once (the row is revoked under its lock, and the signer for that key is dropped, so
 * our copy of the key signs nothing more), and asks the wallet to sign the venue's revoke of the agent permission. An
 * order already sent is not undone: it finishes on the venue, and is read back by its client order id.
 *
 * Crash points (whose funds are stranded?): none, ever. A draw admitted and never signed commits nothing on the venue
 * (it counts against the allowance until the same order is retried and settled, so it can only refuse more). After the
 * signature the bytes are stored before they are sent, and a lost answer is read back by client order id. Funds only
 * ever sit in the person's own sub-account, under their own wallet.
 */

export type OwnAgentTradingCode =
  | 'agents.allowance_amount_unset'
  | 'agents.allowance_amount_invalid'
  | 'agents.allowance_period_unset'
  | 'agents.allowance_request_invalid'
  | 'agents.allowance_unknown'
  | 'agents.allowance_live'
  | 'agents.allowance_reused'
  | 'agents.order_refused'
  | 'agents.allowance_unset'
  | 'agents.allowance_not_signed'
  | 'agents.allowance_ended'
  | 'agents.allowance_revoked'
  | 'agents.allowance_exceeded'
  | 'agents.allowance_action_unknown'
  | 'agents.allowance_action_signed'
  | 'agents.allowance_sub_account_unknown'
  | 'agents.policy_unavailable'
  | 'agents.order_market_unknown'
  | 'agents.order_price_unknown';

export class OwnAgentTradingError extends AgentAccountError {
  constructor(code: OwnAgentTradingCode | string, message: string, status: number, detail: Record<string, unknown> = {}) {
    super(code as never, message, status, detail);
    this.name = 'OwnAgentTradingError';
  }
}

export interface OwnAgentTradingDeps {
  readonly door: UserVenueDoor;
  readonly store: AllowanceStore;
  readonly policy: OwnAgentPolicy | null;
  readonly values: AgentAccountValues;
  readonly now: () => Date;
}

export const ALLOWANCE_PERIODS: readonly AllowancePeriod[] = ['day', 'week', 'month'];
const PERIOD_MS: Record<AllowancePeriod, number> = { day: 86_400_000, week: 7 * 86_400_000, month: 30 * 86_400_000 };

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const ADDRESS_RE = /^0x[0-9a-f]{40}$/;
const DECIMAL_RE = /^[0-9]+(\.[0-9]+)?$/;
const ONE = parseAmount('1');
const TWO = parseAmount('2');
const TEN_THOUSAND = parseAmount('10000');

export const allowanceApproveKey = (allowanceId: string) => `agent:allowance:${allowanceId}:approve`;
export const allowanceRevokeKey = (allowanceId: string) => `agent:allowance:${allowanceId}:revoke`;
export const ownAgentOrderKey = (agentId: string, orderId: string) => `${AGENT_ORDER_PREFIX}${agentId}:${orderId}`;

/** What the wallet is asked to sign next for an allowance, if anything. */
export interface AllowanceNext {
  readonly actionKey: string;
  readonly step: 'approve_agent' | 'revoke_agent';
  readonly prepared: PreparedVenueAction;
  /** Signed and sent with no definite answer yet: re-send it, never sign a new one. */
  readonly signed: boolean;
}

export interface AllowanceView {
  readonly allowanceId: string;
  readonly agentId: string;
  /** `signing`: waiting for the wallet's agent permission; `active`; `ended` (past its end); `revoked`; `abandoned`. */
  readonly status: 'signing' | 'active' | 'ended' | 'revoked' | 'abandoned';
  readonly owner: string;
  readonly subAccount: string;
  readonly asset: string;
  readonly amount: Amount;
  /** The amount less every order the agent drew that the venue has not refused. */
  readonly left: Amount;
  readonly period: AllowancePeriod;
  readonly endsAt: Date;
  readonly agentAddress: string;
  /** Whether the venue's own record still lists the agent permission on the sub-account. */
  readonly permissionOnVenue: boolean;
  readonly revokedAt: Date | null;
  readonly next: AllowanceNext | null;
  /** The venue's refusal of the agent permission, when the allowance was abandoned for one. */
  readonly refusal: VenueRefusal | null;
  readonly test: boolean;
}

export interface OwnAgentOrderPreview {
  readonly allowanceId: string;
  readonly subAccount: string;
  readonly symbol: string;
  readonly side: 'buy' | 'sell';
  readonly type: 'market' | 'limit';
  readonly size: Amount;
  /** The limit, or on a market order the worst price accepted. */
  readonly price: Amount;
  /** What the order commits against the allowance: size × price. */
  readonly notional: Amount;
  readonly asset: string;
  /** The venue's own fee if it fills in full, or `null` when the venue does not say. */
  readonly fee: { readonly asset: string; readonly amount: Amount } | null;
  /** What the allowance has left before this order. */
  readonly left: Amount;
  readonly test: boolean;
}

export interface OwnAgentOrderView {
  readonly orderId: string;
  readonly actionKey: string;
  readonly allowanceId: string;
  readonly subAccount: string;
  readonly symbol: string;
  readonly side: 'buy' | 'sell';
  readonly type: 'market' | 'limit';
  readonly size: Amount;
  readonly price: Amount;
  /** The address that signed it: the allowance's agent key. */
  readonly signedBy: string;
  /** `accepted`: the venue's record of it. `refused`: the venue's refusal. `unknown`: sent, no definite answer yet. `unsent`. */
  readonly state: 'accepted' | 'refused' | 'unknown' | 'unsent';
  readonly order: UserVenueOrder | null;
  readonly refusal: VenueRefusal | null;
  readonly replayed: boolean;
  readonly test: boolean;
}

function fail(code: OwnAgentTradingCode, message: string, status: number, detail: Record<string, unknown> = {}): never {
  throw new OwnAgentTradingError(code, message, status, detail);
}

function uuid(value: unknown, label: string): string {
  const v = typeof value === 'string' ? value.trim().toLowerCase() : '';
  if (!UUID_RE.test(v)) fail('agents.allowance_request_invalid', `${label} must be a UUID`, 400);
  return v;
}

function address(value: unknown, label: string): string {
  const v = typeof value === 'string' ? value.trim().toLowerCase() : '';
  if (!ADDRESS_RE.test(v)) fail('agents.allowance_request_invalid', `${label} must be an address (0x and 40 hex)`, 400);
  return v;
}

/** A decimal string above zero; blank is `blankCode`, naming the field. */
function amountField(value: unknown, field: string, blankCode: OwnAgentTradingCode): Amount {
  const text = typeof value === 'string' ? value.trim() : typeof value === 'bigint' ? formatAmount(value) : '';
  if (text === '') fail(blankCode, `${field} is blank`, 422, { field });
  if (!DECIMAL_RE.test(text))
    fail('agents.allowance_amount_invalid', `${field} must be a decimal string (never a JSON number)`, 422, { field });
  const v = parseAmount(text);
  if (compare(v, ZERO) <= 0) fail('agents.allowance_amount_invalid', `${field} must be above zero`, 422, { field });
  return v;
}

/** `x` rounded to a whole number of `step`s, down or up. */
function toStep(x: Amount, step: Amount, way: 'down' | 'up'): Amount {
  const r = div(x, step, 'floor');
  const whole = r - (r % ONE);
  const steps = way === 'up' && compare(mul(whole, step), x) < 0 ? add(whole, ONE) : whole;
  return mul(steps, step);
}

export class OwnAgentTrading {
  /** One capped signer per agent key, so two orders under one allowance can't both fit in the same room. */
  private readonly signers = new Map<string, CappedAgentSigner>();
  private readonly marks = new Map<string, Map<string, Amount | null>>();

  constructor(private readonly deps: OwnAgentTradingDeps) {}

  private async venue(): Promise<UserVenue> {
    return this.deps.door.venue();
  }

  private sub(a: AllowanceRecord): UserVenueAccount {
    return { venueId: a.venueId, owner: a.owner, subAccount: a.subAccount };
  }

  private seed(): string {
    const seed = this.deps.values.keySeed;
    if (seed === null) {
      throw new AgentAccountError(
        'agents.agent_key_unset',
        'the agent key secret is not set (owner value blank), so no agent can be approved',
        422,
      );
    }
    return seed;
  }

  /** svc-agents' gate for an order on the sub-account: the person's rules and the access they gave the agent. */
  private async assertPolicy(userId: string, agentId: string, subAccount: string): Promise<void> {
    const answer = this.deps.policy ? await this.deps.policy.check(userId, agentId, 'place_order', `sub:${subAccount}`) : null;
    if (answer === null) {
      fail('agents.policy_unavailable', "the agent's rules could not be checked just now; nothing was granted or sent", 503);
    }
    if (!answer.allowed) {
      throw new OwnAgentTradingError(answer.code, `the agent's rules refuse an order on sub-account ${subAccount}: ${answer.code}`, 403, {
        account: `sub:${subAccount}`,
      });
    }
  }

  // ── the allowance (#4 #7) ──────────────────────────────────────────────────────────────────────────────────────

  /**
   * #4: grant an allowance. A blank amount or period refuses naming the field, before anything is asked or stored. The
   * owner's ceiling, the funding asset and the key seed are each an owner value that refuses blank. Then svc-agents' gate
   * must allow an order on the sub-account (the agent is the person's, and has access to it), and the venue must list
   * the sub-account under the person's wallet. The allowance is stored `signing`, and the wallet is asked to sign the
   * venue's agent permission for its key on that sub-account. The same id again is the same allowance.
   */
  async grant(principal: Principal, agentIdRaw: string, req: Record<string, unknown>): Promise<AllowanceView> {
    assertPerson(principal);
    const agentId = uuid(agentIdRaw, 'agentId');
    const allowanceId = uuid(req.allowanceId, 'allowanceId');
    const amount = amountField(req.amount, 'amount', 'agents.allowance_amount_unset');
    const periodText = typeof req.period === 'string' ? req.period.trim() : '';
    if (!ALLOWANCE_PERIODS.includes(periodText as AllowancePeriod)) {
      fail('agents.allowance_period_unset', `period must be one of ${ALLOWANCE_PERIODS.join(', ')}`, 422, { field: 'period' });
    }
    const period = periodText as AllowancePeriod;
    const owner = address(req.owner, 'owner');
    const subAccount = address(req.subAccount, 'subAccount');
    const v = this.deps.values;
    if (v.asset === null) {
      throw new AgentAccountError('agents.account_asset_unset', 'the owner has published no asset an agent allowance is counted in', 422);
    }
    if (v.ceiling === null) {
      throw new AgentAccountError(
        'agents.account_ceiling_unset',
        'the owner has published no ceiling for an agent allowance, so none can be granted',
        422,
      );
    }
    try {
      assertAgentCapWithinCeiling(amount, v.ceiling, v.asset);
    } catch (error) {
      capErrorAs(error);
    }
    const seed = this.seed();
    const existing = await this.deps.store.find(principal.userId, allowanceId);
    if (existing) {
      if (
        existing.agentId !== agentId ||
        existing.amount !== amount ||
        existing.period !== period ||
        existing.subAccount !== subAccount ||
        existing.owner !== owner
      ) {
        fail('agents.allowance_reused', `allowance ${allowanceId} was granted with other terms; a new allowance needs a new id`, 409);
      }
      return this.advance(principal, existing);
    }
    await this.assertPolicy(principal.userId, agentId, subAccount);
    const venue = await this.venue();
    if (!hasSubAccountReads(venue)) {
      throw new AgentAccountError('agents.account_venue_no_sub_accounts', `${venue.venue.displayName} offers no sub-accounts`, 422);
    }
    const listed = (await venue.subAccounts({ venueId: venue.venue.id, owner, subAccount: null })).value;
    if (!listed.some((s) => s.subAccount.toLowerCase() === subAccount)) {
      fail('agents.allowance_sub_account_unknown', `the venue lists no sub-account ${subAccount} under ${owner}`, 422);
    }
    const now = this.deps.now();
    const record: AllowanceRecord = {
      userId: principal.userId,
      allowanceId,
      agentId,
      venueId: venue.venue.id,
      owner,
      subAccount,
      asset: v.asset,
      amount,
      period,
      agentAddress: agentAddressFor(seed, principal.userId, `allowance:${allowanceId}`),
      status: 'signing',
      createdAt: now,
      endsAt: new Date(now.getTime() + PERIOD_MS[period]),
      activeAt: null,
      revokedAt: null,
    };
    const stored = await this.deps.store.insertOnce(record);
    if ('live' in stored) {
      fail('agents.allowance_live', 'this agent already has an allowance; revoke it before granting another', 409, {
        allowanceId: stored.live.allowanceId,
      });
    }
    return this.advance(principal, stored.stored);
  }

  /** The agent's allowances, newest first, each read back from the venue. */
  async list(principal: Principal, agentIdRaw: string): Promise<readonly AllowanceView[]> {
    assertPerson(principal);
    const agentId = uuid(agentIdRaw, 'agentId');
    const rows = await this.deps.store.listForAgent(principal.userId, agentId);
    return Promise.all(rows.map((a) => this.advance(principal, a)));
  }

  private async allowance(principal: Principal, agentId: string, allowanceIdRaw: unknown): Promise<AllowanceRecord> {
    const allowanceId = uuid(allowanceIdRaw, 'allowanceId');
    const a = await this.deps.store.find(principal.userId, allowanceId);
    if (!a || a.agentId !== agentId) fail('agents.allowance_unknown', `no allowance ${allowanceId} for this agent`, 404);
    return a;
  }

  private async prepare(principal: Principal, a: AllowanceRecord, intent: VenueIntent, actionKey: string): Promise<AllowanceNext> {
    const answer = await this.deps.door.prepare(
      principal,
      { owner: a.owner, subAccount: a.subAccount, signer: { role: 'owner', address: a.owner }, intent, actionKey },
      { agentAccount: true },
    );
    return {
      actionKey: answer.actionKey,
      step: intent.kind === 'approve_agent' ? 'approve_agent' : 'revoke_agent',
      prepared: answer.prepared,
      signed: answer.signed,
    };
  }

  /**
   * Bring the allowance up to the venue's record: a signing one is active once the venue lists its agent permission on
   * the sub-account, abandoned once the venue refused it; a revoked one asks the wallet to sign the venue's revoke for as
   * long as the venue still lists the permission. Prepares at most one action, stored before it is returned.
   */
  private async advance(principal: Principal, start: AllowanceRecord): Promise<AllowanceView> {
    let a = start;
    const venue = await this.venue();
    let next: AllowanceNext | null = null;
    let refusal: VenueRefusal | null = null;
    let onVenue = false;
    if (a.status === 'signing' || a.status === 'active' || a.status === 'revoked') {
      onVenue = (await venue.agents(this.sub(a))).value.some((x) => x.address.toLowerCase() === a.agentAddress);
    }
    if (a.status === 'signing') {
      if (onVenue) a = await this.deps.store.activate(a.userId, a.allowanceId, this.deps.now());
      else {
        const o = (await this.deps.door.stored(principal, allowanceApproveKey(a.allowanceId)))?.lastOutcome ?? null;
        if (o?.definite && !o.accepted) {
          refusal = o.refusal;
          a = await this.deps.store.abandon(a.userId, a.allowanceId);
        } else {
          next = await this.prepare(
            principal,
            a,
            { kind: 'approve_agent', agentAddress: a.agentAddress, agentName: `agent-${a.agentId.slice(0, 8)}`, validUntil: a.endsAt },
            allowanceApproveKey(a.allowanceId),
          );
        }
      }
    }
    if (a.status === 'revoked' && onVenue) {
      next = await this.prepare(principal, a, { kind: 'revoke_agent', agentAddress: a.agentAddress }, allowanceRevokeKey(a.allowanceId));
    }
    const draws = await this.deps.store.draws(a.userId, a.allowanceId);
    const ended = a.status === 'active' && this.deps.now().getTime() >= a.endsAt.getTime();
    return {
      allowanceId: a.allowanceId,
      agentId: a.agentId,
      status: ended ? 'ended' : a.status,
      owner: a.owner,
      subAccount: a.subAccount,
      asset: a.asset,
      amount: a.amount,
      left: allowanceLeft(a.amount, draws),
      period: a.period,
      endsAt: a.endsAt,
      agentAddress: a.agentAddress,
      permissionOnVenue: onVenue,
      revokedAt: a.revokedAt,
      next,
      refusal,
      test: isTestVenue(venue.venue),
    };
  }

  /** The wallet's signature of the allowance's agent permission, or of its revoke, sent once under its key. */
  async submit(principal: Principal, agentIdRaw: string, allowanceIdRaw: string, actionKey: unknown, signature: VenueSignature) {
    assertPerson(principal);
    const agentId = uuid(agentIdRaw, 'agentId');
    const a = await this.allowance(principal, agentId, allowanceIdRaw);
    const key = typeof actionKey === 'string' ? actionKey.trim() : '';
    const approve = key === allowanceApproveKey(a.allowanceId);
    if (!approve && key !== allowanceRevokeKey(a.allowanceId)) {
      fail('agents.allowance_action_unknown', `${JSON.stringify(key)} is not an action of allowance ${a.allowanceId}`, 404);
    }
    if (approve && a.status !== 'signing') {
      fail('agents.allowance_not_signed', `allowance ${a.allowanceId} is ${a.status}; its agent permission is no longer asked for`, 409);
    }
    if (!approve && a.status !== 'revoked') {
      fail('agents.allowance_action_unknown', `allowance ${a.allowanceId} is not revoked, so there is no revoke to send`, 409);
    }
    await this.deps.door.submit(principal, key, signature, { agentAccount: true });
    return this.advance(principal, (await this.deps.store.find(a.userId, a.allowanceId))!);
  }

  /** The wallet rejected the agent permission: nothing is granted. Only before it was signed, so it can never be sent. */
  async abandon(principal: Principal, agentIdRaw: string, allowanceIdRaw: string): Promise<AllowanceView> {
    assertPerson(principal);
    const agentId = uuid(agentIdRaw, 'agentId');
    const a = await this.allowance(principal, agentId, allowanceIdRaw);
    if (a.status !== 'signing') fail('agents.allowance_not_signed', `allowance ${a.allowanceId} is ${a.status}`, 409);
    if ((await this.deps.door.stored(principal, allowanceApproveKey(a.allowanceId)))?.signature) {
      fail('agents.allowance_action_signed', 'the agent permission is signed, so it is read back from the venue, not abandoned', 409);
    }
    return this.advance(principal, await this.deps.store.abandon(a.userId, a.allowanceId));
  }

  /**
   * #7: revoke. Admission ends at once (the row is revoked under its lock), and our copy of the key is dropped: the
   * signer for it is removed, and a new one is never made for a revoked allowance. Then the wallet is asked to sign the
   * venue's revoke of the agent permission. An order already sent finishes on the venue and is read back by its id.
   */
  async revoke(principal: Principal, agentIdRaw: string, allowanceIdRaw: string): Promise<AllowanceView> {
    assertPerson(principal);
    const agentId = uuid(agentIdRaw, 'agentId');
    const a = await this.allowance(principal, agentId, allowanceIdRaw);
    if (a.status === 'signing') return this.abandon(principal, agentIdRaw, allowanceIdRaw);
    const revoked = a.status === 'active' ? await this.deps.store.revoke(a.userId, a.allowanceId, this.deps.now()) : a;
    this.signers.delete(revoked.agentAddress);
    this.marks.delete(revoked.agentAddress);
    return this.advance(principal, revoked);
  }

  // ── the agent's order (#3 #5 #6) ───────────────────────────────────────────────────────────────────────────────

  /** The agent's allowance an order may draw on now, or the refusal that says why there is none. */
  private async usable(userId: string, agentId: string): Promise<AllowanceRecord> {
    const rows = await this.deps.store.listForAgent(userId, agentId);
    const live = rows.find((r) => r.status === 'signing' || r.status === 'active');
    if (!live) {
      const last = rows[0];
      if (last?.status === 'revoked') {
        fail('agents.allowance_revoked', 'this agent’s allowance was revoked, so it places no order; nothing was sent', 409);
      }
      fail(
        'agents.allowance_unset',
        'this agent has no allowance, and your wallet has signed no agent permission for it; nothing was sent',
        409,
      );
    }
    if (live.status === 'signing') {
      fail(
        'agents.allowance_not_signed',
        'the agent permission for this allowance is not signed by your wallet yet; nothing was sent',
        409,
      );
    }
    if (this.deps.now().getTime() >= live.endsAt.getTime()) {
      fail('agents.allowance_ended', `this agent's allowance ended at ${live.endsAt.toISOString()}; nothing was sent`, 409);
    }
    return live;
  }

  private async market(venue: UserVenue, sub: UserVenueAccount, base: string, asset: string): Promise<UserVenueMarket> {
    const m = (await venue.markets(sub)).value.find((x) => x.kind === 'spot' && x.baseAsset === base && x.quoteAsset === asset);
    if (!m) fail('agents.order_market_unknown', `${venue.venue.displayName} lists no ${base}-${asset} spot market`, 422);
    return m;
  }

  /** The order's terms as the person's words gave them; a market order's price is its worst, from the mark and the owner's bound. */
  private async terms(
    venue: UserVenue,
    a: AllowanceRecord,
    req: Record<string, unknown>,
  ): Promise<{ market: UserVenueMarket; side: 'buy' | 'sell'; type: 'market' | 'limit'; size: Amount; price: Amount }> {
    const side = req.side;
    if (side !== 'buy' && side !== 'sell') fail('agents.allowance_request_invalid', 'side must be buy or sell', 400);
    const type = req.type ?? 'market';
    if (type !== 'market' && type !== 'limit') fail('agents.allowance_request_invalid', 'type must be market or limit', 400);
    const base = typeof req.base === 'string' ? req.base.trim().toUpperCase() : '';
    if (!/^[A-Z0-9]{2,16}$/.test(base)) fail('agents.allowance_request_invalid', 'base must be an asset symbol', 400);
    const size = amountField(req.size, 'size', 'agents.allowance_amount_invalid');
    const market = await this.market(venue, this.sub(a), base, a.asset);
    if (type === 'limit') return { market, side, type, size, price: amountField(req.price, 'price', 'agents.allowance_amount_invalid') };
    const bps = this.deps.values.bounds.worstPriceBps;
    if (bps === null) {
      throw new AgentAccountError(
        'agents.price_bound_unset',
        'the owner has published no worst price against the mark for agent orders',
        422,
      );
    }
    const book = (await venue.book(market.symbol, 1)).value;
    const bid = book.bids[0]?.price;
    const ask = book.asks[0]?.price;
    if (bid === undefined || ask === undefined) {
      fail('agents.order_price_unknown', `${market.symbol} has no two-sided book just now, so no worst price can be set`, 422);
    }
    const mid = div(add(bid, ask), TWO, 'half-up');
    const worst =
      side === 'buy'
        ? toStep(div(mul(mid, add(TEN_THOUSAND, bps), 'floor'), TEN_THOUSAND, 'floor'), market.tickSize, 'down')
        : toStep(div(mul(mid, sub(TEN_THOUSAND, bps), 'ceil'), TEN_THOUSAND, 'ceil'), market.tickSize, 'up');
    return { market, side, type, size, price: worst };
  }

  private intent(
    key: string,
    t: { market: UserVenueMarket; side: 'buy' | 'sell'; type: 'market' | 'limit'; size: Amount; price: Amount },
  ): PlaceUserOrderIntent {
    return {
      kind: 'place_order',
      symbol: t.market.symbol,
      side: t.side,
      type: t.type,
      amount: t.size,
      price: t.price,
      timeInForce: t.type === 'market' ? 'IOC' : 'GTC',
      reduceOnly: false,
      clientOrderKey: key,
      builderFee: null,
    };
  }

  /**
   * #3 #5: what the agent's order would be, before anything is sent. Refused when the agent has no allowance or its
   * agent permission is not signed (#3), or when svc-agents' gate refuses the sub-account; otherwise the side, market,
   * type, size, price and the venue's own fee, read from the venue. Nothing is stored, signed or sent.
   */
  async preview(principal: Principal, agentIdRaw: string, req: Record<string, unknown>): Promise<OwnAgentOrderPreview> {
    assertPerson(principal);
    const agentId = uuid(agentIdRaw, 'agentId');
    const a = await this.usable(principal.userId, agentId);
    await this.assertPolicy(principal.userId, agentId, a.subAccount);
    const venue = await this.venue();
    const t = await this.terms(venue, a, req);
    const notional = mul(t.size, t.price, 'ceil');
    const left = allowanceLeft(a.amount, await this.deps.store.draws(a.userId, a.allowanceId));
    const preview = (await venue.preview(this.sub(a), this.intent(ownAgentOrderKey(agentId, 'preview'), t))).value;
    return {
      allowanceId: a.allowanceId,
      subAccount: a.subAccount,
      symbol: t.market.symbol,
      side: t.side,
      type: t.type,
      size: t.size,
      price: t.price,
      notional,
      asset: a.asset,
      fee: preview.venueFee.known ? { asset: preview.venueFee.value.asset, amount: preview.venueFee.value.amount } : null,
      left,
      test: isTestVenue(venue.venue),
    };
  }

  private signerFor(a: AllowanceRecord, venue: UserVenue): CappedAgentSigner {
    let s = this.signers.get(a.agentAddress);
    if (!s) {
      const key = agentKeyFor(this.seed(), a.userId, `allowance:${a.allowanceId}`);
      if (key.address.toLowerCase() !== a.agentAddress)
        throw new Error(`agent key of allowance ${a.allowanceId} does not derive to its address`);
      const marks = new Map<string, Amount | null>();
      const look: AgentCapMarks = (asset) => {
        const v = marks.get(asset);
        return v === undefined || v === null ? { known: false } : { known: true, value: v };
      };
      s = new CappedAgentSigner({
        sign: async (prepared: PreparedVenueAction): Promise<VenueSignature> => ({
          digest: prepared.digest,
          signature: await key.signTypedData(prepared.typedData as TypedDataDefinition),
          signedBy: key.address.toLowerCase(),
        }),
        venue,
        marks: look,
        bounds: this.deps.values.bounds,
        now: this.deps.now,
      });
      this.signers.set(a.agentAddress, s);
      this.marks.set(a.agentAddress, marks);
    }
    return s;
  }

  /** The marks the signer judges by, from the venue's own books: the order's base, and each other asset the sub-account holds. */
  private async refreshMarks(a: AllowanceRecord, venue: UserVenue, base: string, symbol: string): Promise<void> {
    const marks = this.marks.get(a.agentAddress)!;
    const sub = this.sub(a);
    const [markets, balances] = await Promise.all([venue.markets(sub), venue.balances(sub)]);
    const mid = async (s: string) => {
      const book = (await venue.book(s, 1)).value;
      const bid = book.bids[0]?.price;
      const ask = book.asks[0]?.price;
      return bid !== undefined && ask !== undefined ? div(add(bid, ask), TWO, 'half-up') : null;
    };
    marks.set(base, await mid(symbol));
    for (const b of balances.value) {
      if (b.asset === a.asset || b.asset === base || compare(b.total, ZERO) === 0) continue;
      const m = markets.value.find((x) => x.kind === 'spot' && x.baseAsset === b.asset && x.quoteAsset === a.asset);
      marks.set(b.asset, m ? await mid(m.symbol) : null);
    }
  }

  /**
   * #6: the person approved the preview. svc-agents' gate is asked again, the draw is admitted under the allowance's row
   * lock, and only then does the agent key sign, through the capped signer; the order is sent once under its key. The
   * same order id again reads the venue's record first and never signs again.
   */
  async place(principal: Principal, agentIdRaw: string, req: Record<string, unknown>): Promise<OwnAgentOrderView> {
    assertPerson(principal);
    const agentId = uuid(agentIdRaw, 'agentId');
    const orderId = uuid(req.orderId, 'orderId');
    const key = ownAgentOrderKey(agentId, orderId);
    const venue = await this.venue();
    // A draw already admitted for this order is this order: its terms, its allowance, its key.
    const earlier = await this.deps.store.findDraw(principal.userId, orderId);
    let a: AllowanceRecord;
    if (earlier) {
      a = (await this.deps.store.find(principal.userId, earlier.allowanceId))!;
      if (a.agentId !== agentId) fail('agents.allowance_unknown', `order ${orderId} belongs to another agent`, 404);
      const stored = await this.deps.door.stored(principal, key);
      if (stored?.signature) return this.readBackOrResend(principal, a, earlier, key, stored.signature, venue);
    } else a = await this.usable(principal.userId, agentId);
    await this.assertPolicy(principal.userId, agentId, a.subAccount);
    const t = await this.terms(venue, a, req);
    const draw: DrawRecord = {
      userId: principal.userId,
      allowanceId: a.allowanceId,
      orderId,
      symbol: t.market.symbol,
      side: t.side,
      type: t.type,
      size: t.size,
      price: t.price,
      amount: mul(t.size, t.price, 'ceil'),
      state: 'admitted',
      createdAt: this.deps.now(),
    };
    // A retried market order keeps the worst price it was admitted at, so its terms stay the same order's.
    const admitted = await this.deps.store.admit(
      earlier ? { ...draw, price: earlier.price, amount: earlier.amount, createdAt: earlier.createdAt } : draw,
      this.deps.now(),
    );
    if (!admitted.admitted) {
      const left = { left: formatAmount(admitted.left), asset: a.asset };
      switch (admitted.refusal) {
        case 'revoked':
          fail('agents.allowance_revoked', 'this agent’s allowance was revoked, so it places no order; nothing was sent', 409);
        case 'ended':
          fail('agents.allowance_ended', `this agent's allowance ended at ${a.endsAt.toISOString()}; nothing was sent`, 409);
        case 'not_active':
          fail('agents.allowance_not_signed', 'the agent permission for this allowance is not signed yet; nothing was sent', 409);
        case 'exceeded':
          fail(
            'agents.allowance_exceeded',
            `this order commits ${formatAmount(draw.amount)} ${a.asset}; the allowance has ${left.left} left; nothing was sent`,
            422,
            left,
          );
        case 'draw_refused':
          fail('agents.order_refused', `the order ${orderId} was refused and is never sent again; a new order needs a new id`, 409);
        case 'order_reused':
          throw new UserVenueDoorError(
            `the order id ${orderId} was already used for a different order; a new order needs a new id`,
            'idempotency.conflict',
            409,
          );
      }
    }
    const d = admitted.draw;
    const intent = this.intent(key, { market: t.market, side: d.side, type: d.type, size: d.size, price: d.price });
    let prepared: PreparedVenueAction;
    try {
      prepared = (
        await this.deps.door.prepare(
          principal,
          { owner: a.owner, subAccount: a.subAccount, signer: { role: 'agent', address: a.agentAddress }, intent },
          // The order's worst price is already the owner's agent bound against the book (`terms`), so the door's own
          // spot protection is not applied on top of it.
          { agentAccount: true, ownWorstPrice: true },
        )
      ).prepared;
    } catch (error) {
      throw this.venueNamed(error, venue, key);
    }
    // The invariant this route keeps: the order names the allowance's sub-account and its agent key, nothing else.
    if (
      prepared.account.owner.toLowerCase() !== a.owner ||
      prepared.account.subAccount !== a.subAccount ||
      prepared.signer.role !== 'agent' ||
      prepared.signer.address.toLowerCase() !== a.agentAddress
    ) {
      throw new Error(`agent order ${key} was prepared outside its allowance's sub-account; nothing is signed`);
    }
    // Read the allowance again just before the key signs: a revoke after the admission still stops the signature, and
    // the cap the signer holds the order to carries the revoke too.
    const now = (await this.deps.store.find(a.userId, a.allowanceId))!;
    if (now.status !== 'active') {
      await this.deps.store.refuse(a.userId, orderId);
      fail('agents.allowance_revoked', 'this agent’s allowance was revoked before the order was signed; nothing was sent', 409);
    }
    const signer = this.signerFor(now, venue);
    await this.refreshMarks(now, venue, t.market.baseAsset, t.market.symbol);
    const cap: AgentCap = {
      account: this.sub(now),
      agentAddress: now.agentAddress,
      asset: now.asset,
      cap: now.amount,
      validUntil: now.endsAt,
      revokedAt: now.revokedAt,
    };
    let signature: VenueSignature;
    try {
      ({ signature } = await signer.sign(prepared, cap));
    } catch (error) {
      // Nothing was signed, so nothing can be sent: the draw no longer counts.
      await this.deps.store.refuse(a.userId, orderId);
      if (error instanceof AgentCapError) capErrorAs(error);
      if (error instanceof VenueRefusalError && error.refusal.code.startsWith('agent_cap')) {
        throw new AgentAccountError(
          error.refusal.code === 'agent_cap_exceeded' ? 'agents.order_cap_exceeded' : 'agents.order_cap_refused',
          error.refusal.detail,
          422,
          { capCode: error.refusal.code },
        );
      }
      throw this.venueNamed(error, venue, key);
    }
    return this.send(principal, now, d, key, signature, venue, false);
  }

  private async send(
    principal: Principal,
    a: AllowanceRecord,
    d: DrawRecord,
    key: string,
    signature: VenueSignature,
    venue: UserVenue,
    replayed: boolean,
  ): Promise<OwnAgentOrderView> {
    let outcome: VenueSubmitOutcome;
    let wasReplay = replayed;
    try {
      const sent = await this.deps.door.submit(principal, key, signature, { agentAccount: true });
      outcome = sent.outcome;
      wasReplay = wasReplay || sent.replayed;
    } catch (error) {
      throw this.venueNamed(error, venue, key);
    }
    const cloid = (await this.deps.door.stored(principal, key))?.prepared.venueClientOrderId ?? null;
    if (outcome.definite) {
      if (cloid) this.signers.get(a.agentAddress)?.settle(cloid);
      if (!outcome.accepted) {
        await this.deps.store.refuse(a.userId, d.orderId);
        throw new AgentVenueRefusal(outcome.refusal, venue.venue.displayName, key);
      }
      return this.view(a, d, key, venue, 'accepted', outcome.order ?? null, null, wasReplay);
    }
    return this.view(a, d, key, venue, 'unknown', null, null, wasReplay);
  }

  /** The same order again after its bytes were signed: the venue's record by client order id, or the stored bytes again. */
  private async readBackOrResend(
    principal: Principal,
    a: AllowanceRecord,
    d: DrawRecord,
    key: string,
    signature: VenueSignature,
    venue: UserVenue,
  ): Promise<OwnAgentOrderView> {
    const read = await this.deps.door.orderByKey(principal, key);
    if (read.state === 'accepted') {
      if (read.venueClientOrderId) this.signers.get(a.agentAddress)?.settle(read.venueClientOrderId);
      return this.view(a, d, key, venue, 'accepted', read.order, null, true);
    }
    if (read.state === 'refused' && read.refusal) {
      if (read.venueClientOrderId) this.signers.get(a.agentAddress)?.settle(read.venueClientOrderId);
      await this.deps.store.refuse(a.userId, d.orderId);
      throw new AgentVenueRefusal(read.refusal, venue.venue.displayName, key);
    }
    return this.send(principal, a, d, key, signature, venue, true);
  }

  /** The agent's orders, oldest first, each read back from the venue by its client order id. Reads only. */
  async orders(principal: Principal, agentIdRaw: string): Promise<readonly OwnAgentOrderView[]> {
    assertPerson(principal);
    const agentId = uuid(agentIdRaw, 'agentId');
    const venue = await this.venue();
    const out: OwnAgentOrderView[] = [];
    for (const a of await this.deps.store.listForAgent(principal.userId, agentId)) {
      for (const d of await this.deps.store.draws(a.userId, a.allowanceId)) {
        const key = ownAgentOrderKey(agentId, d.orderId);
        const stored = await this.deps.door.stored(principal, key);
        if (!stored?.signature) {
          out.push(this.view(a, d, key, venue, 'unsent', null, null, false));
          continue;
        }
        const read = await this.deps.door.orderByKey(principal, key);
        out.push(
          this.view(
            a,
            d,
            key,
            venue,
            read.state === 'accepted' ? 'accepted' : read.state === 'refused' ? 'refused' : 'unknown',
            read.order,
            read.refusal ?? null,
            false,
          ),
        );
      }
    }
    return out.sort((x, y) => (x.orderId < y.orderId ? -1 : 1));
  }

  private venueNamed(error: unknown, venue: UserVenue, key: string): unknown {
    if (error instanceof VenueRefusalError && error.refusal.code !== 'venue_down')
      return new AgentVenueRefusal(error.refusal, venue.venue.displayName, key);
    return error;
  }

  private view(
    a: AllowanceRecord,
    d: DrawRecord,
    key: string,
    venue: UserVenue,
    state: OwnAgentOrderView['state'],
    order: UserVenueOrder | null,
    refusal: VenueRefusal | null,
    replayed: boolean,
  ): OwnAgentOrderView {
    return {
      orderId: d.orderId,
      actionKey: key,
      allowanceId: a.allowanceId,
      subAccount: a.subAccount,
      symbol: d.symbol,
      side: d.side,
      type: d.type,
      size: d.size,
      price: d.price,
      signedBy: a.agentAddress,
      state,
      order,
      refusal,
      replayed,
      test: isTestVenue(venue.venue),
    };
  }
}
